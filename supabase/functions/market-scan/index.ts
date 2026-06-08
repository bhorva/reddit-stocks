// Supabase Edge Function: market-scan
//
// Runs every 6 hours (triggered by pg_cron, see supabase/trading_schema.sql).
// Each run it:
//   1. discovers which tickers are CURRENTLY trending on Reddit by scanning
//      hot posts for cashtags / ticker-shaped words (no fixed ticker list —
//      the watchlist is reseeded with whatever is hot right now)
//   2. counts recent mentions for each candidate (real Reddit API, OAuth2)
//      and fetches its price + short history (Stooq, no API key needed)
//   3. classifies the signal as organic / spike / pure-hype
//   4. applies the pump-&-dip trading strategy and logs every trade
//   5. records a portfolio balance snapshot for the chart
//
// Tickers with an open position are always re-evaluated (so we can sell even
// if they fall out of the "currently trending" set), everything else is
// rotated in/out of `watchlist.active` based on what's hot this run.
//
// Reddit access: as of late 2025 Reddit no longer issues OAuth client
// credentials to new developers on a self-service basis (manual review,
// weeks-long wait, personal projects mostly rejected — see "Responsible
// Builder Policy"). We therefore use Reddit's public, unauthenticated JSON
// endpoints (`https://www.reddit.com/r/<sub>/hot.json`,
// `.../search.json`) instead of `oauth.reddit.com`. These remain freely
// readable without an app/registration — only a descriptive `User-Agent`
// is required. Rate limits are looser than what a 6-hourly scan of three
// subreddits needs.
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

const REDDIT_SUBREDDITS = ['stocks', 'wallstreetbets', 'investing'];
const HISTORY_LOOKBACK = 8; // how many past signal rows to use for the hype baseline

// ── Dynamic ticker discovery ─────────────────────────────────────────────
const DISCOVERY_POST_LIMIT = 75; // hot posts scanned per subreddit for candidates
const CANDIDATE_POOL_SIZE = 25; // top mention-ranked candidates to validate against Stooq
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

function swissquoteFee(amount: number): number {
  if (amount < 500) return 15;
  if (amount < 2000) return 25;
  if (amount < 10000) return 30;
  if (amount < 15000) return 55;
  if (amount < 25000) return 80;
  if (amount < 50000) return 135;
  return 190;
}

// ── Reddit: public, unauthenticated JSON endpoints ──────────────────────
// No app registration / OAuth needed — `www.reddit.com/.../*.json` is
// readable by anyone as long as a descriptive User-Agent is sent (Reddit's
// API rules require this to identify the client). This is the documented
// fallback now that self-service OAuth credential creation is gated behind
// a multi-week manual review that personal projects rarely pass.
const REDDIT_USER_AGENT = 'web:reddit-stocks-market-scan:v1.0 (by /u/reddit-stocks-bot)';

function redditHeaders(): HeadersInit {
  return { 'User-Agent': REDDIT_USER_AGENT };
}

/** Counts how often $TICKER (or the bare ticker as a word) was mentioned in
 * the last 24h across the watched subreddits. */
async function countRedditMentions(ticker: string): Promise<number> {
  let total = 0;
  const since = Date.now() / 1000 - 24 * 60 * 60;
  for (const subreddit of REDDIT_SUBREDDITS) {
    const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(
      ticker,
    )}&restrict_sr=1&sort=new&limit=50&t=day`;
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) {
      console.warn(`Reddit search failed for r/${subreddit} ${ticker}: ${res.status}`);
      continue;
    }
    const data = await res.json();
    const posts: any[] = data?.data?.children ?? [];
    const wordRe = new RegExp(`\\b\\$?${ticker}\\b`, 'i');
    for (const post of posts) {
      const created = post?.data?.created_utc ?? 0;
      if (created < since) continue;
      const text = `${post?.data?.title ?? ''} ${post?.data?.selftext ?? ''}`;
      if (wordRe.test(text)) total += 1;
    }
  }
  return total;
}

/** Scans hot posts across the watched subreddits and extracts ticker-shaped
 * symbols (cashtags like "$NVDA" score higher than bare all-caps words like
 * "NVDA", since cashtags are an explicit, low-noise signal). Returns a score
 * per discovered symbol, highest first. */
async function discoverTrendingTickers(): Promise<[string, number][]> {
  const scores = new Map<string, number>();
  for (const subreddit of REDDIT_SUBREDDITS) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${DISCOVERY_POST_LIMIT}`;
    const res = await fetch(url, { headers: redditHeaders() });
    if (!res.ok) {
      console.warn(`Reddit hot listing failed for r/${subreddit}: ${res.status}`);
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
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

// ── Prices: Stooq daily CSV, no API key required ─────────────────────────
async function fetchPriceHistory(ticker: string): Promise<number[]> {
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase())}.us&i=d`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Stooq fetch failed for ${ticker}: ${res.status}`);
  }
  const csv = await res.text();
  const lines = csv.trim().split('\n').slice(1); // drop header row
  const closes = lines
    .map((line) => parseFloat(line.split(',')[4]))
    .filter((n) => Number.isFinite(n));
  return closes.slice(-30); // last ~30 trading days, oldest first
}

// ── Hype classification ──────────────────────────────────────────────────
type Verdict = 'organic' | 'spike' | 'pure-hype';

function classify(
  mentionCount: number,
  history: SignalRow[],
  priceHistory: number[],
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

  if (hypeScore > HYPE_BLOCK_THR && priceFallingOrFlat) {
    return {
      hypeScore,
      verdict: 'pure-hype',
      blocked: true,
      reason:
        `Hype-Score ${hypeScore.toFixed(0)} > ${HYPE_BLOCK_THR} bei ${mentionCount} Erwähnungen ` +
        `(Ø ${baseline.toFixed(1)}), aber Kurs fällt/stagniert seit ${priceHistory.length} Tagen — ` +
        `keine fundamentale Bestätigung. Geblockt.`,
    };
  }
  if (isSpike && priceFallingOrFlat) {
    return {
      hypeScore,
      verdict: 'spike',
      blocked: false,
      reason:
        `Mention-Spike (${mentionCount} vs. Ø ${baseline.toFixed(1)}) ohne begleitende ` +
        `Kursbewegung — verdächtig, wird beobachtet, aber nicht gehandelt.`,
    };
  }
  return {
    hypeScore,
    verdict: 'organic',
    blocked: false,
    reason: `${mentionCount} Erwähnungen (Ø ${baseline.toFixed(1)}), Kursverlauf bestätigt die Richtung.`,
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

    // ── Phase 1: discover what's currently trending on Reddit ───────────
    // No fixed ticker list — rank candidate symbols by mention weight, then
    // validate each against Stooq (real ticker + has price data) until the
    // hot list is full. This naturally filters out slang that slipped past
    // the stopword list (e.g. invented acronyms with no matching security).
    const ranked = await discoverTrendingTickers();
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
        // Not a real/listed ticker (or Stooq has nothing for it) — skip.
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
      const [mentionCount, { data: history }] = await Promise.all([
        countRedditMentions(ticker),
        supabase
          .from('signals')
          .select('ticker, scanned_at, price, mention_count, hype_score')
          .eq('ticker', ticker)
          .order('scanned_at', { ascending: false })
          .limit(HISTORY_LOOKBACK),
      ]);

      if (priceHistory.length === 0) {
        log.push(`${ticker}: keine Kursdaten von Stooq erhalten — übersprungen.`);
        continue;
      }
      const price = priceHistory[priceHistory.length - 1];
      latestPrices.set(ticker, price);

      const { hypeScore, verdict, blocked, reason } = classify(
        mentionCount,
        (history ?? []) as SignalRow[],
        priceHistory,
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
              reason: `Dip erkannt: ${(dropFromHigh * 100).toFixed(1)}% unter dem ${HISTORY_LOOKBACK}-Tage-Hoch, Hype organisch bestätigt.`,
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
