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
//   4. applies the swing-trading strategy and logs every trade (see the
//      strategy-constants block below for why it's swing- rather than
//      pump-&-dip-shaped — the latter doesn't survive Swissquote's fees)
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

// ── Strategy constants ───────────────────────────────────────────────────
// Originally a fast "pump & dip" reactor mirroring the file.html prototype
// (±2.5%/±4% thresholds, react every 6h). That shape cannot survive contact
// with Swissquote's real cost structure: EVERY round trip — win or lose —
// pays roughly 6.3% in brokerage commission + FX margin (see FX_FEE_RATE and
// swissquoteFee() below). That's a near-fixed tax on each trade, not
// something a bigger take-profit alone can fix: raising TAKE_PROFIT from 4%
// to 8% (an earlier iteration of this constant) only made the asymmetry
// worse — net win ≈ +1.7%, net loss ≈ -9.8%, which requires an ~85% hit rate
// just to break even. No realistic heuristic clears that bar.
//
// So the strategy is now modelled as SWING trading: fewer, larger moves over
// days-to-weeks rather than many small reactions every few hours. That makes
// the ~6.3% round-trip tax a much smaller fraction of the targeted move, and
// brings the breakeven hit rate down to something a genuine (if modest) edge
// can plausibly clear — see the math at TAKE_PROFIT/STOP_LOSS below. Exits
// are still checked every ~6h here and every ~15-30min by `price-refresh`,
// so a swing target is never "missed" for lack of looking.
const POSITION_SIZE = 0.12; // fraction of total portfolio value per buy

// A swing entry wants a real pullback into a base, not a blip that fully
// reverts before the next scan even looks at it — -2.5% is noise on a
// multi-week chart. Widened to -4%, and (see the buy-check below) now
// measured against a multi-week high rather than an intraday wiggle, so the
// signal means "this stock pulled back meaningfully," not "it dipped for an
// hour."
const DIP_THRESH = -0.04; // buy once price has dropped this much from its recent (multi-week) high

// TAKE_PROFIT / STOP_LOSS sized for SWING trades. The ~6.3% round-trip tax
// (≈25 CHF Swissquote commission + ~0.95% FX margin EACH WAY on a ~12%-of-
// portfolio position) hits every exit, win or lose — so what matters isn't
// "does the winning side clear it" but how it reshapes BOTH sides:
//
//   net win  ≈ TAKE_PROFIT - 0.063  =  0.20 - 0.063  ≈ +13.7%
//   net loss ≈ STOP_LOSS   - 0.063  = -0.06 - 0.063  ≈ -12.3%
//   breakeven hit rate = |net loss| / (net win + |net loss|) ≈ 47%
//
// ~47% is a realistic bar — a heuristic with a genuine, if modest, edge can
// clear it — versus the ~85% the previous ±8%/±3.5% pair implied. The two
// net outcomes are also now close to symmetric, so profitability isn't
// hostage to an unrealistically lopsided hit rate in either direction.
const TAKE_PROFIT = 0.20; // sell once a position gains this much
const STOP_LOSS = -0.06; // sell once a position loses this much
const MAX_POSITIONS = 5;
const HYPE_BLOCK_THR = 65; // hype score above which a ticker can be blocked

// Currency-conversion spread Swissquote charges when trading USD-denominated
// stocks from a CHF-denominated account (in addition to the brokerage
// commission below). Roughly 0.95% each way — previously NOT modelled at all,
// which made the simulation noticeably too optimistic given the entire
// watchlist trades in USD. See swissquote.com fee schedule ("Fremdwährungen").
const FX_FEE_RATE = 0.0095;

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
  opening_transaction_id: number | null;
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

// Currency-conversion spread on top of the brokerage commission — every trade
// here is a USD-denominated US stock bought/sold from a CHF account.
function fxFee(amount: number): number {
  return amount * FX_FEE_RATE;
}

/**
 * Looks up the brokerage fee + FX margin paid when a position was OPENED, via
 * its linked `opening_transaction_id` — needed so `realized_pnl` on the SELL
 * can reflect the true round-trip cost rather than just the exit-side cost
 * (see the comment at the realized_pnl computation for why that distinction
 * matters). Returns zeros for legacy positions opened before the v2 migration
 * (no link available) — same "predates the richer logging" convention as
 * elsewhere, rather than guessing at a number we don't actually have.
 */
async function fetchOpeningCosts(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  openingTransactionId: number | null,
): Promise<{ fee: number; fxFee: number }> {
  if (openingTransactionId === null) return { fee: 0, fxFee: 0 };
  const { data, error } = await supabase
    .from('transactions')
    .select('fee, fx_fee')
    .eq('id', openingTransactionId)
    .maybeSingle();
  if (error || !data) return { fee: 0, fxFee: 0 };
  return { fee: Number(data.fee) || 0, fxFee: Number(data.fx_fee) || 0 };
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

// ── Intraday prices: finer-grained "recent high" for dip detection ───────
// `fetchPriceHistory` above returns DAILY closes — fine for confirming the
// multi-day trend (hype classification), but much too coarse for deciding
// whether "price has dropped >2.5% from its recent high RIGHT NOW": a ticker
// can swing several percent intraday and fully revert before the next daily
// close is even recorded, by which point a 6-hourly scan reading only daily
// data would be reacting to a stale, already-reverted signal. Pulling 5 days
// of 30-minute bars gives the dip check actual intraday resolution while
// staying within Yahoo's free, keyless chart API.
async function fetchIntradayPrices(ticker: string): Promise<number[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=5d&interval=30m`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (data?.chart?.error || !result) return [];
    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    return closes.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).slice(-80);
  } catch {
    return [];
  }
}

// ── Benchmark: SPY price, so the dashboard can show "vs. simply holding an
// index fund" — the only honest way to tell whether this strategy is adding
// value over a naive baseline rather than just riding a rising market.
async function fetchBenchmarkPrice(): Promise<number | null> {
  try {
    const history = await fetchPriceHistory('SPY');
    return history.length ? history[history.length - 1] : null;
  } catch {
    return null;
  }
}

// ── Hype classification ──────────────────────────────────────────────────
// Correlates THREE independent signals so a single noisy source can't drive
// a trade: how much MORE a ticker is being mentioned than usual (Reddit/
// ApeWisdom + supplementary direct scan), whether the wider crowd actually
// agrees with a bullish read (StockTwits sentiment), and whether the price
// itself confirms the story (Yahoo Finance). Only when mentions, sentiment AND price
// roughly agree do we call it "organic" and let the trading logic act on it.
type Verdict = 'organic' | 'spike' | 'pure-hype';

interface ClassificationResult {
  hypeScore: number;
  verdict: Verdict;
  blocked: boolean;
  reason: string;
  // Exposed for `signal_snapshot` — so a future review can reconstruct
  // exactly what the engine "believed" at the moment of a trade without
  // re-deriving it from the prose `reason` string.
  baselineMentions: number;
  zScore: number;
  priceTrendPct: number;
  sentimentRatio: number | null;
}

// Hype score is now a proper rolling z-score of the mention count against its
// own historical mean/stddev — scale-invariant and statistically meaningful,
// unlike the previous ad-hoc linear transform `((x - baseline) / spread) *
// 33.3 + 30` (arbitrary constants, not comparable across tickers with very
// different mention-count volatility). A z-score of 0 sits at hype=50; +-3
// standard deviations map to the 0..100 ends of the scale.
function classify(
  mentionCount: number,
  history: SignalRow[],
  priceHistory: number[],
  sentiment: SentimentSummary | null,
): ClassificationResult {
  const counts = history.map((s) => s.mention_count);
  const n = counts.length;
  const mean = n ? counts.reduce((sum, c) => sum + c, 0) / n : mentionCount;
  const variance = n > 1 ? counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  // With <2 historical points, or zero variance (e.g. a brand-new ticker),
  // fall back to a conservative neutral-ish z-score rather than dividing by
  // zero or producing a wildly unstable first reading.
  const zScore = stddev > 0 ? (mentionCount - mean) / stddev : mentionCount > mean ? 2 : 0;
  const hypeScore = Math.max(0, Math.min(100, 50 + zScore * (50 / 3)));
  const baseline = mean;

  const priceTrend =
    priceHistory.length >= 2 ? priceHistory[priceHistory.length - 1] - priceHistory[0] : 0;
  const priceTrendPct = priceHistory.length >= 2 && priceHistory[0] !== 0 ? (priceTrend / priceHistory[0]) * 100 : 0;
  const priceFallingOrFlat = priceTrend <= 0;
  const isSpike = baseline > 0 && mentionCount > baseline * 3;

  // Crowd-sentiment confirmation: is the wider trading crowd actually bullish,
  // or does the mention spike look one-sided / unconfirmed by sentiment?
  let sentimentNote = 'keine Stimmungsdaten verfügbar';
  let sentimentConfirmsBullish = false;
  let sentimentContradicts = false;
  let sentimentRatio: number | null = null;
  if (sentiment && sentiment.bullish + sentiment.bearish >= 5) {
    sentimentRatio = sentiment.bullish / (sentiment.bullish + sentiment.bearish);
    sentimentConfirmsBullish = sentimentRatio >= 0.55;
    sentimentContradicts = sentimentRatio <= 0.4;
    sentimentNote = `StockTwits-Stimmung ${(sentimentRatio * 100).toFixed(0)}% bullish (${sentiment.bullish}↑/${sentiment.bearish}↓)`;
  }

  const common = { hypeScore, baselineMentions: baseline, zScore, priceTrendPct, sentimentRatio };

  // Pure hype: loud on Reddit, but neither the crowd's sentiment nor the price
  // backs it up — the textbook "pump" setup we must not chase.
  if (hypeScore > HYPE_BLOCK_THR && priceFallingOrFlat && !sentimentConfirmsBullish) {
    return {
      ...common,
      verdict: 'pure-hype',
      blocked: true,
      reason:
        `Hype-Score ${hypeScore.toFixed(0)} (z=${zScore.toFixed(1)}) > ${HYPE_BLOCK_THR} bei ${mentionCount} Erwähnungen ` +
        `(Ø ${baseline.toFixed(1)}), Kurs fällt/stagniert (${priceTrendPct.toFixed(1)}% über ${priceHistory.length} Tage), ${sentimentNote} ` +
        `— keine fundamentale Bestätigung. Geblockt.`,
    };
  }
  // Spike: loud, but either the crowd contradicts the hype or the price hasn't
  // moved — wait and watch instead of trading it.
  if (isSpike && (priceFallingOrFlat || sentimentContradicts)) {
    return {
      ...common,
      verdict: 'spike',
      blocked: false,
      reason:
        `Mention-Spike (${mentionCount} vs. Ø ${baseline.toFixed(1)}, z=${zScore.toFixed(1)}), ${sentimentNote}, ` +
        `ohne übereinstimmende Kursbewegung (${priceTrendPct.toFixed(1)}%) — verdächtig, wird beobachtet, aber nicht gehandelt.`,
    };
  }
  return {
    ...common,
    verdict: 'organic',
    blocked: false,
    reason: `${mentionCount} Erwähnungen (Ø ${baseline.toFixed(1)}, z=${zScore.toFixed(1)}), ${sentimentNote}, Kursverlauf ${priceTrendPct >= 0 ? '+' : ''}${priceTrendPct.toFixed(1)}% bestätigt die Richtung.`,
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

    // `blocked_count`/`blocked_capital` describe THIS run's "how much did we
    // choose not to risk just now" — not a lifetime total. Resetting them
    // here (rather than letting them accumulate across every 6-hourly run
    // forever) is what keeps the dashboard's "X CHF nicht riskiert" stat
    // meaningful: a lifetime sum would grow without bound — after a year of
    // ~4 runs/day with, say, 2 blocks each at ~1'200 CHF, it would already
    // read in the millions, telling the user nothing about the PORTFOLIO's
    // current state, only about how long the bot has been running.
    portfolio.blocked_count = 0;
    portfolio.blocked_capital = 0;

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

    for (const [ticker, dailyHistory] of evaluationSet) {
      const [sentiment, intradayHistory, { data: history }] = await Promise.all([
        fetchStockTwitsSentiment(ticker),
        fetchIntradayPrices(ticker),
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

      if (dailyHistory.length === 0) {
        log.push(`${ticker}: keine Kursdaten von Yahoo Finance erhalten — übersprungen.`);
        continue;
      }
      // Use the freshest intraday close we have as "current price" — daily
      // closes lag by up to a trading day and would make every decision act
      // on stale data. Fall back to the daily close only if Yahoo's intraday
      // endpoint returned nothing for this ticker.
      const recentPrices = intradayHistory.length > 0 ? intradayHistory : dailyHistory;
      const price = recentPrices[recentPrices.length - 1];
      latestPrices.set(ticker, price);

      const { hypeScore, verdict, blocked, reason, baselineMentions, zScore, priceTrendPct, sentimentRatio } = classify(
        mentionCount,
        (history ?? []) as SignalRow[],
        dailyHistory,
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
          const fx = fxFee(grossAmount);
          const proceeds = grossAmount - fee - fx;
          const costBasis = position.shares * position.entry_price;
          // `costBasis` only covers what was actually invested (shares ×
          // entry price) — the BUY's brokerage fee + FX margin were paid out
          // of `cash` separately and never show up here. Without subtracting
          // them too, `realized_pnl` looks rosier than the trade truly was:
          // e.g. a +4% exit nets ~+11 CHF by this measure alone, while the
          // portfolio's cash actually moved by roughly -25 CHF once the
          // entry costs are counted — a "win" that's a real loss. Fetching
          // the linked opening transaction (cheap: sells are infrequent)
          // makes this number mean what it says.
          const openingCosts = await fetchOpeningCosts(supabase, position.opening_transaction_id);
          const realizedPnl = proceeds - costBasis - openingCosts.fee - openingCosts.fxFee;
          const exitReason: 'take-profit' | 'stop-loss' = change >= TAKE_PROFIT ? 'take-profit' : 'stop-loss';

          await supabase.from('transactions').insert({
            ticker,
            action: 'sell',
            shares: position.shares,
            price,
            fee,
            fx_fee: fx,
            currency: 'USD',
            gross_amount: grossAmount,
            realized_pnl: realizedPnl,
            opening_transaction_id: position.opening_transaction_id,
            exit_reason: exitReason,
            reason:
              exitReason === 'take-profit'
                ? `Take-Profit erreicht: +${(change * 100).toFixed(1)}% seit Einstieg.`
                : `Stop-Loss ausgelöst: ${(change * 100).toFixed(1)}% seit Einstieg.`,
          });
          await supabase.from('positions').delete().eq('id', position.id);
          positions.splice(positions.indexOf(position), 1);

          portfolio.cash += proceeds;
          portfolio.realized_pnl += realizedPnl;
          portfolio.total_fees += fee + fx;
          portfolio.trade_count += 1;
          log.push(`${ticker}: SELL ${position.shares} @ ${price} (PnL ${realizedPnl.toFixed(2)} CHF, Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX)`);
          continue;
        }
      }

      // ── Buy check: dip detected, room for a new position, organic verdict ──
      if (
        !position &&
        verdict === 'organic' &&
        positions.length < MAX_POSITIONS
      ) {
        // For a SWING entry, "the recent high" should mean a meaningful
        // multi-week reference point, not an intraday wiggle — measuring
        // against ~30 daily closes (≈6 weeks) means DIP_THRESH represents
        // "this stock pulled back materially from its recent range," which is
        // what a swing setup actually wants. (Using intraday data here, as an
        // earlier iteration did, would trigger on noise: a stock can dip 4%
        // for an hour and fully revert by the next scan — not a base worth
        // swinging into.) `price` itself still comes from the freshest
        // intraday close (see above) — only the reference HIGH is long-range.
        const recentHigh = Math.max(...dailyHistory);
        const dropFromHigh = (price - recentHigh) / recentHigh;
        if (dropFromHigh <= DIP_THRESH) {
          const totalValue =
            portfolio.cash +
            positions.reduce((sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price), 0);
          const budget = totalValue * POSITION_SIZE;
          const fee = swissquoteFee(budget);
          const fx = fxFee(budget);
          const investable = budget - fee - fx;
          const shares = investable > 0 ? investable / price : 0;

          if (shares > 0 && portfolio.cash >= budget) {
            const grossAmount = shares * price;
            // Structured snapshot of every feature the engine considered —
            // so a future review can run e.g. "of all organic-verdict buys,
            // what fraction closed at take-profit vs. stop-loss, bucketed by
            // hype-score-at-entry?" directly via SQL instead of re-deriving
            // it from the prose `reason` string.
            const signalSnapshot = {
              hype_score: Math.round(hypeScore * 10) / 10,
              z_score: Math.round(zScore * 100) / 100,
              mention_count: mentionCount,
              baseline_mentions: Math.round(baselineMentions * 10) / 10,
              sentiment_ratio: sentimentRatio === null ? null : Math.round(sentimentRatio * 1000) / 1000,
              price_trend_pct: Math.round(priceTrendPct * 100) / 100,
              drop_from_high_pct: Math.round(dropFromHigh * 1000) / 10,
              verdict,
              intraday_points: intradayHistory.length,
            };

            const { data: txRow } = await supabase
              .from('transactions')
              .insert({
                ticker,
                action: 'buy',
                shares,
                price,
                fee,
                fx_fee: fx,
                currency: 'USD',
                gross_amount: grossAmount,
                signal_snapshot: signalSnapshot,
                reason: `Swing-Einstieg: ${(dropFromHigh * 100).toFixed(1)}% unter dem Mehrwochenhoch (${dailyHistory.length} Handelstage Historie), Hype organisch (Score ${hypeScore.toFixed(0)}, z=${zScore.toFixed(1)}) & von Stimmung/Kurs bestätigt.`,
              })
              .select()
              .single();

            const { data: inserted } = await supabase
              .from('positions')
              .insert({ ticker, shares, entry_price: price, opening_transaction_id: txRow?.id ?? null })
              .select()
              .single();
            if (inserted) positions.push(inserted as PositionRow);

            portfolio.cash -= grossAmount + fee + fx;
            portfolio.total_fees += fee + fx;
            portfolio.trade_count += 1;
            log.push(`${ticker}: BUY ${shares.toFixed(4)} @ ${price} (Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX)`);
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
    const spyPrice = await fetchBenchmarkPrice();
    if (spyPrice === null) {
      log.push('SPY-Benchmarkpreis konnte nicht geladen werden — Vergleichschart bleibt für diesen Lauf ohne neuen Punkt.');
    }
    await supabase.from('balance_history').insert({
      cash: portfolio.cash,
      positions_value: positionsValue,
      total_value: portfolio.cash + positionsValue,
      spy_price: spyPrice,
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
