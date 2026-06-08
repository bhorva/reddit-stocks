// Supabase Edge Function: market-scan
//
// Runs every 6 hours (triggered by pg_cron, see supabase/trading_schema.sql).
// Each run it:
//   1. discovers which tickers are CURRENTLY trending by combining several
//      independent signal sources (no fixed ticker list — the watchlist is
//      reseeded with whatever is hot right now)
//   2. correlates mention counts with crowd sentiment and price history,
//      and fetches each candidate's price (Yahoo Finance, no API key needed)
//   3. classifies the signal as organic / spike / pure-hype
//   4. applies the pump-&-dip trading strategy and logs every trade
//   5. records a portfolio balance snapshot for the chart
//
// Tickers with an open position are always re-evaluated (so we can sell even
// if they fall out of the "currently trending" set), everything else is
// rotated in/out of `watchlist.active` based on what's hot this run.
//
// ── Why several sources instead of just "the Reddit API" ────────────────
// Supabase Edge Functions run on AWS infrastructure. Reddit (via Cloudflare)
// blocks requests from cloud/datacenter IP ranges with HTTP 403 — regardless
// of whether you call the public `www.reddit.com/*.json` endpoints or the
// authenticated `oauth.reddit.com` API (and self-service OAuth credentials
// are no longer issued to new developers either, see "Responsible Builder
// Policy"). Rather than depend on a single, fragile, often-blocked path, we
// fan out to several independent, cloud-friendly sources and correlate them:
//
//   • ApeWisdom   — a free, keyless aggregator that *already* scans the major
//                    stock subreddits (wallstreetbets, stocks, options, ...)
//                    twice an hour and exposes ranked mention counts. This is
//                    our PRIMARY Reddit-derived signal, since it does the
//                    Reddit-scraping for us from infrastructure Reddit
//                    doesn't block. https://apewisdom.io/api/
//   • old.reddit.com — a best-effort DIRECT fetch of Reddit's own JSON, kept
//                    as a supplementary source. It is wrapped so that a 403
//                    (likely, from cloud IPs) is logged and simply ignored —
//                    if Reddit ever loosens IP-based blocking, this starts
//                    contributing again with zero further changes.
//   • StockTwits  — a free, keyless public symbol stream that exposes crowd
//                    sentiment tags (bullish/bearish) per message. Used to
//                    CORRELATE: a mention spike that the wider trading crowd
//                    actually agrees is bullish looks "organic"; a spike with
//                    flat/bearish sentiment looks like manufactured "hype".
//   • Yahoo Finance — free daily price history via the public chart JSON API
//                    (no key needed); the fundamental "did the market
//                    actually move" check. (We switched to this from Stooq's
//                    CSV endpoint, which started serving a JS bot-check page
//                    instead of data — observed even from non-cloud IPs.)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// ── Strategy constants (mirrors the file.html prototype) ────────────────
const POSITION_SIZE = 0.12; // fraction of total portfolio value per buy
const DIP_THRESH = -0.025; // buy once price has dropped this much from its recent high
const TAKE_PROFIT = 0.04; // sell once a position gains this much
const STOP_LOSS = -0.035; // sell once a position loses this much
const MAX_POSITIONS = 5;
const HYPE_BLOCK_THR = 65; // hype score above which a ticker can be blocked

const HISTORY_LOOKBACK = 8; // how many past signal rows to use for the hype baseline

// ── Dynamic ticker discovery ─────────────────────────────────────────────
const CANDIDATE_POOL_SIZE = 25; // top mention-ranked candidates to validate against Yahoo Finance
const HOT_LIST_SIZE = 10; // how many validated tickers make the active watchlist

const CASHTAG_RE = /\$([A-Z]{1,5})\b/g;
const CAPS_WORD_RE = /\b([A-Z]{2,5})\b/g;

// Common acronyms/slang that look like tickers but aren't — without this,
// "DD", "YOLO", "CEO" etc. would constantly crowd out real symbols.
const TICKER_STOPWORDS = new Set([
  'YOLO', 'DD', 'CEO', 'CFO', 'CTO', 'COO', 'IPO', 'ATH', 'ETF', 'USA', 'USD',
  'EOD', 'FOMO', 'FUD', 'IMO', 'IMHO', 'LOL', 'WSB', 'SEC', 'FED', 'GDP', 'CPI',
  'AI', 'IT', 'OK', 'ETC', 'AKA', 'FAQ', 'TLDR', 'PSA', 'RIP', 'PM', 'AM',
  'NYSE', 'OTC', 'EPS', 'ROI', 'YTD', 'QOQ', 'YOY', 'API', 'NFT', 'AMA', 'GG',
  'WTF', 'SPAC', 'PE', 'VC', 'IRS', 'HQ', 'US', 'UK', 'EU', 'ATM', 'BTFD', 'FD',
  'OTM', 'ITM', 'DTE', 'IV', 'TA', 'FA', 'ER', 'EDIT', 'TIL', 'ELI5', 'FYI',
  'NVM', 'IDK', 'TBH', 'SO', 'TO', 'OF', 'IN', 'ON', 'AT', 'BY', 'IS', 'BE',
  'DO', 'GO', 'NO', 'UP', 'MY', 'ME', 'WE', 'HE', 'ALL', 'NEW', 'OLD', 'BUY',
  'SELL', 'HOLD', 'CALL', 'CALLS', 'PUT', 'PUTS', 'MOON', 'BEAR', 'BULL',
  'RED', 'GREEN', 'LONG', 'SHORT', 'CASH', 'YES', 'NOT', 'ONE', 'TWO', 'NOW',
  'CAN', 'GET', 'GOT', 'WHO', 'WHY', 'HOW', 'OUR', 'OUT', 'ANY', 'ARE', 'AND',
]);

const REDDIT_SUBREDDITS = ['stocks', 'wallstreetbets', 'investing'];
const DISCOVERY_POST_LIMIT = 75; // hot posts scanned per subreddit (best-effort source)

// A descriptive User-Agent is required by Reddit's API rules to identify the
// client — sent on the best-effort direct-Reddit calls.
const REDDIT_USER_AGENT = 'web:reddit-stocks-market-scan:v1.0 (by /u/reddit-stocks-bot)';

interface WatchlistRow {
  ticker: string;
  name: string | null;
  active: boolean;
}

interface SignalRow {
  ticker: string;
  scanned_at: string;
  price: number;
  mention_count: number;
  hype_score: number;
}

interface PositionRow {
  id: number;
  ticker: string;
  shares: number;
  entry_price: number;
}

interface PortfolioRow {
  cash: number;
  realized_pnl: number;
  total_fees: number;
  trade_count: number;
  blocked_count: number;
  blocked_capital: number;
}

interface SentimentSummary {
  bullish: number;
  bearish: number;
  total: number;
}

function swissquoteFee(amount: number): number {
  if (amount < 500) return 15;
  if (amount < 2000) return 25;
  if (amount < 10000) return 30;
  if (amount < 15000) return 55;
  if (amount < 25000) return 80;
  if (amount < 50000) return 135;
  return 190;
}

// ── Source 1 (primary): ApeWisdom — pre-aggregated Reddit mention ranking ─
// Free, keyless API that already scans wallstreetbets/stocks/options/investing
// for ticker mentions from infrastructure Reddit doesn't block. This is our
// main "what's trending on Reddit right now" signal.
// Docs: https://apewisdom.io/api/
async function fetchApeWisdomRanking(): Promise<Map<string, number>> {
  const mentions = new Map<string, number>();
  for (const page of [1, 2]) {
    const url = `https://apewisdom.io/api/v1.0/filter/all-stocks/page/${page}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        console.warn(`ApeWisdom fetch failed (page ${page}): ${res.status}`);
        continue;
      }
      const data = await res.json();
      const results: any[] = data?.results ?? [];
      for (const entry of results) {
        const ticker = String(entry?.ticker ?? '').toUpperCase().trim();
        const count = Number(entry?.mentions ?? 0);
        if (!ticker || TICKER_STOPWORDS.has(ticker) || !Number.isFinite(count)) continue;
        mentions.set(ticker, (mentions.get(ticker) ?? 0) + count);
      }
    } catch (err) {
      console.warn(`ApeWisdom fetch errored (page ${page}): ${err}`);
    }
  }
  return mentions;
}

// ── Source 2 (supplementary, best-effort): direct Reddit scan ────────────
// Kept as a bonus signal: if Reddit ever stops 403-ing cloud IPs, this starts
// contributing again automatically. Failures (expected: 403 from AWS IPs) are
// logged once and otherwise ignored — they must never fail the whole run.
async function fetchOldRedditCashtags(): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  for (const subreddit of REDDIT_SUBREDDITS) {
    const url = `https://old.reddit.com/r/${subreddit}/hot.json?limit=${DISCOVERY_POST_LIMIT}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': REDDIT_USER_AGENT,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) {
        console.warn(`[supplementary] old.reddit hot listing failed for r/${subreddit}: ${res.status} (likely cloud-IP block, ignoring)`);
        continue;
      }
      const data = await res.json();
      const posts: any[] = data?.data?.children ?? [];
      for (const post of posts) {
        const text = `${post?.data?.title ?? ''} ${post?.data?.selftext ?? ''}`;
        const seenInPost = new Set<string>();
        for (const match of text.matchAll(CASHTAG_RE)) {
          const symbol = match[1].toUpperCase();
          if (TICKER_STOPWORDS.has(symbol) || seenInPost.has(symbol)) continue;
          seenInPost.add(symbol);
          scores.set(symbol, (scores.get(symbol) ?? 0) + 2);
        }
        for (const match of text.matchAll(CAPS_WORD_RE)) {
          const symbol = match[1].toUpperCase();
          if (TICKER_STOPWORDS.has(symbol) || seenInPost.has(symbol)) continue;
          seenInPost.add(symbol);
          scores.set(symbol, (scores.get(symbol) ?? 0) + 1);
        }
      }
    } catch (err) {
      console.warn(`[supplementary] old.reddit fetch errored for r/${subreddit}: ${err} (ignoring)`);
    }
  }
  return scores;
}

// ── Source 3 (correlation): StockTwits crowd sentiment ───────────────────
// Free, keyless public symbol stream. We use the bullish/bearish tags the
// community attaches to messages as an independent confirmation signal: does
// the wider trading crowd actually share the bullish read implied by a Reddit
// mention spike, or does it look like one-sided manufactured hype?
// Docs (community): api.stocktwits.com/api/2/streams/symbol/{SYMBOL}.json
async function fetchStockTwitsSentiment(ticker: string): Promise<SentimentSummary | null> {
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker)}.json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`StockTwits fetch failed for ${ticker}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const messages: any[] = data?.messages ?? [];
    let bullish = 0;
    let bearish = 0;
    for (const msg of messages) {
      const basic = msg?.entities?.sentiment?.basic;
      if (basic === 'Bullish') bullish += 1;
      else if (basic === 'Bearish') bearish += 1;
    }
    return { bullish, bearish, total: messages.length };
  } catch (err) {
    console.warn(`StockTwits fetch errored for ${ticker}: ${err}`);
    return null;
  }
}

// ── Prices: Yahoo Finance public chart JSON, no API key required ─────────
// Stooq's CSV endpoint started returning a JS bot-verification page instead
// of data (`This site requires JavaScript to verify your browser`) — even
// from residential IPs, so it's not a cloud-blocking issue, just a dead
// source. Yahoo's public `/v8/finance/chart` JSON endpoint is free, keyless,
// and gives us the same daily-close history we need.
async function fetchPriceHistory(ticker: string): Promise<number[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=1mo&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`Yahoo Finance fetch failed for ${ticker}: ${res.status}`);
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (data?.chart?.error || !result) {
    throw new Error(`Yahoo Finance has no data for ${ticker}`);
  }
  const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
  const valid = closes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  return valid.slice(-30); // last ~30 trading days, oldest first
}

// ── Hype classification ──────────────────────────────────────────────────
// Correlates THREE independent signals so a single noisy source can't drive
// a trade: how much MORE a ticker is being mentioned than usual (Reddit/
// ApeWisdom + supplementary direct scan), whether the wider crowd actually
// agrees with a bullish read (StockTwits sentiment), and whether the price
// itself confirms the story (Yahoo Finance). Only when mentions, sentiment AND price
// roughly agree do we call it "organic" and let the trading logic act on it.
type Verdict = 'organic' | 'spike' | 'pure-hype';

function classify(
  mentionCount: number,
  history: SignalRow[],
  priceHistory: number[],
  sentiment: SentimentSummary | null,
): { hypeScore: number; verdict: Verdict; blocked: boolean; reason: string } {
  const baseline = history.length
    ? history.reduce((sum, s) => sum + s.mention_count, 0) / history.length
    : mentionCount;
  const spread = Math.max(baseline, 1);
  // Hype score: how far above its own baseline the mention count currently is,
  // scaled into a 0-100 range (100 = 4x the historical average or more).
  const hypeScore = Math.max(0, Math.min(100, ((mentionCount - baseline) / spread) * 33.3 + 30));

  const priceTrend =
    priceHistory.length >= 2 ? priceHistory[priceHistory.length - 1] - priceHistory[0] : 0;
  const priceFallingOrFlat = priceTrend <= 0;
  const isSpike = baseline > 0 && mentionCount > baseline * 3;

  // Crowd-sentiment confirmation: is the wider trading crowd actually bullish,
  // or does the mention spike look one-sided / unconfirmed by sentiment?
  let sentimentNote = 'keine Stimmungsdaten verfügbar';
  let sentimentConfirmsBullish = false;
  let sentimentContradicts = false;
  if (sentiment && sentiment.bullish + sentiment.bearish >= 5) {
    const ratio = sentiment.bullish / (sentiment.bullish + sentiment.bearish);
    sentimentConfirmsBullish = ratio >= 0.55;
    sentimentContradicts = ratio <= 0.4;
    sentimentNote = `StockTwits-Stimmung ${(ratio * 100).toFixed(0)}% bullish (${sentiment.bullish}↑/${sentiment.bearish}↓)`;
  }

  // Pure hype: loud on Reddit, but neither the crowd's sentiment nor the price
  // backs it up — the textbook "pump" setup we must not chase.
  if (hypeScore > HYPE_BLOCK_THR && priceFallingOrFlat && !sentimentConfirmsBullish) {
    return {
      hypeScore,
      verdict: 'pure-hype',
      blocked: true,
      reason:
        `Hype-Score ${hypeScore.toFixed(0)} > ${HYPE_BLOCK_THR} bei ${mentionCount} Erwähnungen ` +
        `(Ø ${baseline.toFixed(1)}), Kurs fällt/stagniert seit ${priceHistory.length} Tagen, ${sentimentNote} ` +
        `— keine fundamentale Bestätigung. Geblockt.`,
    };
  }
  // Spike: loud, but either the crowd contradicts the hype or the price hasn't
  // moved — wait and watch instead of trading it.
  if (isSpike && (priceFallingOrFlat || sentimentContradicts)) {
    return {
      hypeScore,
      verdict: 'spike',
      blocked: false,
      reason:
        `Mention-Spike (${mentionCount} vs. Ø ${baseline.toFixed(1)}), ${sentimentNote}, ` +
        `ohne übereinstimmende Kursbewegung — verdächtig, wird beobachtet, aber nicht gehandelt.`,
    };
  }
  return {
    hypeScore,
    verdict: 'organic',
    blocked: false,
    reason: `${mentionCount} Erwähnungen (Ø ${baseline.toFixed(1)}), ${sentimentNote}, Kursverlauf bestätigt die Richtung.`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────
Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log: string[] = [];
  try {
    const { data: portfolioRow, error: portfolioError } = await supabase
      .from('portfolio')
      .select('*')
      .eq('id', true)
      .single();
    if (portfolioError) throw portfolioError;
    const portfolio = portfolioRow as PortfolioRow;

    const { data: openPositions, error: positionsError } = await supabase
      .from('positions')
      .select('*');
    if (positionsError) throw positionsError;
    const positions = (openPositions ?? []) as PositionRow[];
    const positionTickers = new Set(positions.map((p) => p.ticker));

    const latestPrices = new Map<string, number>();

    // ── Phase 1: discover what's currently trending ─────────────────────
    // Fan out to all sources in parallel and merge them into one ranked
    // candidate list: ApeWisdom (pre-aggregated Reddit mentions, weighted
    // highest since it's purpose-built and reliable from cloud IPs) plus the
    // best-effort direct-Reddit cashtag scan (counts as a bonus when it gets
    // through). Then validate each candidate against Yahoo Finance (real, listed
    // ticker with price data) until the hot list is full.
    const [apeWisdomMentions, supplementaryScores] = await Promise.all([
      fetchApeWisdomRanking(),
      fetchOldRedditCashtags(),
    ]);
    log.push(
      `Quellen: ApeWisdom lieferte ${apeWisdomMentions.size} Ticker, ` +
        `direkter Reddit-Scan lieferte ${supplementaryScores.size} Kandidaten ` +
        `(0 = vermutlich von Reddit aus der Cloud-IP geblockt, kein Problem dank ApeWisdom).`,
    );

    const combinedScores = new Map<string, number>();
    for (const [ticker, count] of apeWisdomMentions) {
      combinedScores.set(ticker, (combinedScores.get(ticker) ?? 0) + count * 3);
    }
    for (const [ticker, score] of supplementaryScores) {
      combinedScores.set(ticker, (combinedScores.get(ticker) ?? 0) + score);
    }
    const ranked = [...combinedScores.entries()].sort((a, b) => b[1] - a[1]);

    const hotPriceHistory = new Map<string, number[]>();
    for (const [symbol] of ranked.slice(0, CANDIDATE_POOL_SIZE)) {
      if (hotPriceHistory.size >= HOT_LIST_SIZE) break;
      if (hotPriceHistory.has(symbol)) continue;
      try {
        const history = await fetchPriceHistory(symbol);
        if (history.length > 0) {
          hotPriceHistory.set(symbol, history);
        }
      } catch {
        // Not a real/listed ticker (or Yahoo Finance has nothing for it) — skip.
      }
    }
    log.push(`Entdeckt & validiert: ${[...hotPriceHistory.keys()].join(', ') || '(keine)'}`);

    // ── Phase 2: sync the watchlist table with the hot list ─────────────
    // Tickers with an open position stay evaluable even if they've cooled
    // off (so we can still react to take-profit/stop-loss), but only the
    // hot list counts as "active" for new buys.
    const { data: existingWatchlist, error: watchlistError } = await supabase
      .from('watchlist')
      .select('ticker, name, active');
    if (watchlistError) throw watchlistError;
    const existingByTicker = new Map(
      ((existingWatchlist ?? []) as WatchlistRow[]).map((w) => [w.ticker, w]),
    );

    for (const ticker of hotPriceHistory.keys()) {
      const existing = existingByTicker.get(ticker);
      if (!existing) {
        await supabase.from('watchlist').insert({ ticker, active: true });
        log.push(`${ticker}: neu entdeckt und zur Watchlist hinzugefügt.`);
      } else if (!existing.active) {
        await supabase.from('watchlist').update({ active: true }).eq('ticker', ticker);
      }
    }
    for (const [ticker, watch] of existingByTicker) {
      if (watch.active && !hotPriceHistory.has(ticker) && !positionTickers.has(ticker)) {
        await supabase.from('watchlist').update({ active: false }).eq('ticker', ticker);
        log.push(`${ticker}: nicht mehr unter den Top-Trends, aus aktiver Watchlist entfernt.`);
      }
    }

    // ── Phase 3: evaluate every hot ticker plus anything we still hold ──
    const evaluationSet = new Map<string, number[]>(hotPriceHistory);
    for (const ticker of positionTickers) {
      if (!evaluationSet.has(ticker)) {
        try {
          evaluationSet.set(ticker, await fetchPriceHistory(ticker));
        } catch {
          evaluationSet.set(ticker, []);
        }
      }
    }

    for (const [ticker, priceHistory] of evaluationSet) {
      const [sentiment, { data: history }] = await Promise.all([
        fetchStockTwitsSentiment(ticker),
        supabase
          .from('signals')
          .select('ticker, scanned_at, price, mention_count, hype_score')
          .eq('ticker', ticker)
          .order('scanned_at', { ascending: false })
          .limit(HISTORY_LOOKBACK),
      ]);

      // Mention count = our combined Reddit-derived signal (ApeWisdom is the
      // reliable backbone; the direct scan adds on top when it isn't blocked).
      const mentionCount = Math.round(
        (apeWisdomMentions.get(ticker) ?? 0) + (supplementaryScores.get(ticker) ?? 0),
      );

      if (priceHistory.length === 0) {
        log.push(`${ticker}: keine Kursdaten von Yahoo Finance erhalten — übersprungen.`);
        continue;
      }
      const price = priceHistory[priceHistory.length - 1];
      latestPrices.set(ticker, price);

      const { hypeScore, verdict, blocked, reason } = classify(
        mentionCount,
        (history ?? []) as SignalRow[],
        priceHistory,
        sentiment,
      );

      const { error: signalError } = await supabase.from('signals').insert({
        ticker,
        price,
        mention_count: mentionCount,
        hype_score: hypeScore,
        verdict,
        blocked,
        reason,
      });
      if (signalError) throw signalError;
      log.push(`${ticker}: ${verdict} (hype=${hypeScore.toFixed(0)}, mentions=${mentionCount}, price=${price})`);

      if (blocked) {
        portfolio.blocked_count += 1;
        portfolio.blocked_capital += portfolio.cash * POSITION_SIZE;
        continue;
      }

      // ── Sell check: existing position hit take-profit or stop-loss ──
      const position = positions.find((p) => p.ticker === ticker);
      if (position) {
        const change = (price - position.entry_price) / position.entry_price;
        if (change >= TAKE_PROFIT || change <= STOP_LOSS) {
          const grossAmount = position.shares * price;
          const fee = swissquoteFee(grossAmount);
          const proceeds = grossAmount - fee;
          const costBasis = position.shares * position.entry_price;
          const realizedPnl = proceeds - costBasis;

          await supabase.from('transactions').insert({
            ticker,
            action: 'sell',
            shares: position.shares,
            price,
            fee,
            gross_amount: grossAmount,
            realized_pnl: realizedPnl,
            reason:
              change >= TAKE_PROFIT
                ? `Take-Profit erreicht: +${(change * 100).toFixed(1)}% seit Einstieg.`
                : `Stop-Loss ausgelöst: ${(change * 100).toFixed(1)}% seit Einstieg.`,
          });
          await supabase.from('positions').delete().eq('id', position.id);
          positions.splice(positions.indexOf(position), 1);

          portfolio.cash += proceeds;
          portfolio.realized_pnl += realizedPnl;
          portfolio.total_fees += fee;
          portfolio.trade_count += 1;
          log.push(`${ticker}: SELL ${position.shares} @ ${price} (PnL ${realizedPnl.toFixed(2)} CHF)`);
          continue;
        }
      }

      // ── Buy check: dip detected, room for a new position, organic verdict ──
      if (
        !position &&
        verdict === 'organic' &&
        positions.length < MAX_POSITIONS
      ) {
        const recentHigh = Math.max(...priceHistory);
        const dropFromHigh = (price - recentHigh) / recentHigh;
        if (dropFromHigh <= DIP_THRESH) {
          const totalValue =
            portfolio.cash +
            positions.reduce((sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price), 0);
          const budget = totalValue * POSITION_SIZE;
          const fee = swissquoteFee(budget);
          const investable = budget - fee;
          const shares = investable > 0 ? investable / price : 0;

          if (shares > 0 && portfolio.cash >= budget) {
            const grossAmount = shares * price;
            await supabase.from('transactions').insert({
              ticker,
              action: 'buy',
              shares,
              price,
              fee,
              gross_amount: grossAmount,
              reason: `Dip erkannt: ${(dropFromHigh * 100).toFixed(1)}% unter dem ${HISTORY_LOOKBACK}-Tage-Hoch, Hype organisch & von Stimmung/Kurs bestätigt.`,
            });
            const { data: inserted } = await supabase
              .from('positions')
              .insert({ ticker, shares, entry_price: price })
              .select()
              .single();
            if (inserted) positions.push(inserted as PositionRow);

            portfolio.cash -= grossAmount + fee;
            portfolio.total_fees += fee;
            portfolio.trade_count += 1;
            log.push(`${ticker}: BUY ${shares.toFixed(4)} @ ${price} (fee ${fee} CHF)`);
          }
        }
      }
    }

    // ── Persist portfolio + balance snapshot ──────────────────────────
    await supabase
      .from('portfolio')
      .update({ ...portfolio, updated_at: new Date().toISOString() })
      .eq('id', true);

    const positionsValue = positions.reduce(
      (sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price),
      0,
    );
    await supabase.from('balance_history').insert({
      cash: portfolio.cash,
      positions_value: positionsValue,
      total_value: portfolio.cash + positionsValue,
    });

    return new Response(JSON.stringify({ ok: true, log }, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: String(err), log }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
