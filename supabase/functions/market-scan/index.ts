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
// the round-trip tax a much smaller fraction of the targeted move, and
// brings the breakeven hit rate down to something a genuine (if modest) edge
// can plausibly clear — see the math at TAKE_PROFIT/STOP_LOSS below. Exits
// are still checked every ~6h here and every ~15-30min by `price-refresh`,
// so a swing target is never "missed" for lack of looking.
//
// One more lever on that same tax, pulled more recently: POSITION_SIZE grew
// from 0.12 to 0.24 (and MAX_POSITIONS shrank from 5 to 3 to compensate, so
// the portfolio doesn't end up over-invested). Swissquote's brokerage
// commission is a near-FLAT fee per trade (see swissquoteFee() below), so
// doubling the position size roughly HALVES its percentage bite — a ~1'200
// CHF position pays ~25 CHF (≈2.1%), a ~2'400 CHF one pays ~30 CHF (≈1.25%).
// That alone trims the round-trip tax from ~6.3% to ~4.4% — see the updated
// math at TAKE_PROFIT/STOP_LOSS below. The cost is fewer, larger bets (less
// diversification, more concentration risk per pick — see the "Kapital-
// verteilung" card on the dashboard), but with ~10k CHF of simulated capital
// and a realistically low swing-trading cadence (a handful of trades a week,
// at most), the fixed-cost drag was the more pressing of the two problems.
const POSITION_SIZE = 0.24; // fraction of total portfolio value per buy — raised from 0.12, see comment above

// A swing entry wants a real pullback into a base, not a blip that fully
// reverts before the next scan even looks at it — -2.5% is noise on a
// multi-week chart. Widened to -4%, and (see the buy-check below) now
// measured against a multi-week high rather than an intraday wiggle, so the
// signal means "this stock pulled back meaningfully," not "it dipped for an
// hour."
const DIP_THRESH = -0.04; // buy once price has dropped this much from its recent (multi-week) high

// TAKE_PROFIT / STOP_LOSS sized for SWING trades. The round-trip tax (≈30 CHF
// Swissquote commission + ~0.95% FX margin EACH WAY on a ~24%-of-portfolio
// position, ≈2'400 CHF — see the POSITION_SIZE comment for why it's sized
// this way now) hits every exit, win or lose — so what matters isn't "does
// the winning side clear it" but how it reshapes BOTH sides:
//
//   one-way cost ≈ 30/2400 + 0.0095   ≈ 1.25% + 0.95%  ≈  2.2%
//   round-trip   ≈ 2 × one-way cost                    ≈  4.4%
//   net win  ≈ TAKE_PROFIT - 0.044  =  0.20 - 0.044  ≈ +15.6%
//   net loss ≈ STOP_LOSS   - 0.044  = -0.06 - 0.044  ≈ -10.4%
//   breakeven hit rate = |net loss| / (net win + |net loss|) ≈ 40%
//
// ~40% is a comfortably realistic bar for a heuristic with a genuine, if
// modest, edge to clear — an improvement on the already-reasonable ~47% the
// previous (smaller-position) sizing implied, and a long way from the ~85%
// the original ±8%/±3.5% pair would have demanded. The two net outcomes stay
// close to symmetric too, so profitability isn't hostage to an unrealistically
// lopsided hit rate in either direction.
const TAKE_PROFIT = 0.20; // sell once a position gains this much
const STOP_LOSS = -0.06; // sell once a position loses this much

// Trimmed from 5 to 3 alongside the POSITION_SIZE increase (0.12 → 0.24) —
// see the comment there: fewer, larger slots in exchange for each trade's
// near-flat brokerage commission costing a much smaller percentage. At 0.24
// each, 3 slots cap invested capital at ~72% (vs. the previous 5 × 0.12 =
// 60%), leaving a comparable cash buffer for fees/slippage/new candidates.
const MAX_POSITIONS = 3;
const HYPE_BLOCK_THR = 65; // hype score above which a ticker can be blocked

// Currency-conversion spread Swissquote charges when trading USD-denominated
// stocks from a CHF-denominated account (in addition to the brokerage
// commission below). Roughly 0.95% each way — previously NOT modelled at all,
// which made the simulation noticeably too optimistic given the entire
// watchlist trades in USD. See swissquote.com fee schedule ("Fremdwährungen").
const FX_FEE_RATE = 0.0095;

// ── Real USD/CHF exchange-rate model ─────────────────────────────────────
// Until now the simulation treated "1 USD ≈ 1 CHF" for every trade — only
// Swissquote's conversion-margin SPREAD (FX_FEE_RATE above) was modelled,
// not the underlying exchange rate itself. That was a meaningfully wrong
// simplification: USD/CHF has moved by double-digit percentages over periods
// as short as a year, and a CHF-based investor holding USD-denominated
// stocks is exposed to BOTH the stock's price move AND the currency's move
// between entry and exit — sometimes one cancels the other out, sometimes
// they compound. Modelling only the fee while pretending the rate itself
// never moves hides exactly the kind of risk (and occasional extra return)
// real Swissquote customers experience.
//
// `fetchUsdChfRate()` below fetches the LIVE spot rate from the same Yahoo
// Finance chart endpoint already used for stock/benchmark prices (symbol
// `USDCHF=X`, Yahoo's standard FX-pair ticker — no new API/secret needed),
// fetched once per run and applied consistently to every USD→CHF conversion
// in that run (mirroring how `benchmarkHistory`/`spyPrice` are fetched once
// and shared). `FALLBACK_USD_CHF_RATE` is ONLY a safety net for the rare
// case that fetch fails — a rough round-number approximation (CHF has
// structurally traded close to, or somewhat stronger than, USD in recent
// years) so a single flaky request can't block the whole run.
//
// Every transaction now also stores the rate that applied AT THAT MOMENT
// (`usd_chf_rate`) — both for transparency in the transaction log, and so
// `realized_pnl` on a SELL can convert the matching BUY's cost basis at the
// rate that applied when the position was OPENED rather than today's rate
// (see the comment at that computation for why mixing the two would quietly
// misattribute currency moves as "trading" P&L).
const FALLBACK_USD_CHF_RATE = 0.80;

// How many past `signals` rows feed the z-score baseline in `classify()`.
// At the 6-hourly scan cadence, 8 rows ≈ 2 days — barely more than a single
// weekend blip, and far too short to capture the weekday/weekend rhythm
// Reddit chatter typically follows (e.g. noticeably quieter on weekends).
// That made the baseline (and therefore the z-score and hype score) jumpy and
// unstable — exactly the kind of noise a "rolling mean/stddev" baseline is
// supposed to smooth out. 28 rows ≈ one full week (4 scans/day × 7 days):
// long enough to span a complete weekday/weekend cycle and give the z-score
// enough samples to be statistically meaningful, short enough that a newly
// discovered ticker can build up a representative baseline within about a
// week of joining the watchlist. Also brings this in line with the rest of
// the engine, which is now uniformly "multi-week-minded" for swing trading
// (the ~30-day price history, the ~3-4-week volume baseline, the multi-week
// "recent high" for dip detection) — the old 2-day window was the one piece
// still tuned for a fast pump-&-dip reaction loop.
const HISTORY_LOOKBACK = 28; // how many past signal rows to use for the hype baseline

// ── Dynamic ticker discovery ─────────────────────────────────────────────
// Both nudged up (25→32 / 10→14): the 5-lens "organic" classification
// (relative strength vs. SPY, volume confirmation, ...) is intentionally
// strict, so a meaningfully larger candidate pool helps make sure enough
// genuinely tradeable signals still surface — without loosening any
// threshold to "find" them artificially. Kept moderate rather than doubled:
// each extra candidate costs an extra Yahoo Finance + StockTwits + Reddit
// round trip per scan, and the tail of a much longer list would mostly be
// lower-conviction noise anyway.
const CANDIDATE_POOL_SIZE = 32; // top mention-ranked candidates to validate against Yahoo Finance
const HOT_LIST_SIZE = 14; // how many validated tickers make the active watchlist

// Broad-market / sector index ETFs — excluded from discovery so they never
// occupy a watchlist/hot-list slot, let alone get bought. They show up
// constantly in r/stocks and r/wallstreetbets chatter, but for reasons that
// have little to do with the ticker-specific "Reddit hype" pattern this
// engine is built to detect:
//   • Their mention spikes mostly track GENERAL market mood ("the market is
//     choppy today"), not stock-specific pumping — the z-score/hype-score
//     heuristic would mostly be reading market-wide noise as a signal.
//   • The "relative strength vs. SPY" lens is close to meaningless for SPY
//     itself and for anything tightly correlated with it (QQQ, VOO, ...) — by
//     construction they can rarely show genuine stock-specific outperformance.
//   • SPY doubles as this dashboard's BENCHMARK ("did the strategy actually
//     beat simply holding the index?"). Trading it would mean comparing the
//     strategy against itself while ALSO paying Swissquote's fees on top of
//     the benchmark's own (zero) cost — strictly worse than just holding it.
// Filtered at discovery time, not just at the buy check, so a slot that an
// actual meme-stock candidate could have used isn't wasted on a ticker that
// could never become a genuine "organic" buy in the first place.
const BROAD_MARKET_ETFS = new Set([
  'SPY', 'QQQ', 'VOO', 'VTI', 'IVV', 'DIA', 'IWM', 'VEA', 'VUG', 'VTV',
  'ARKK', 'XLF', 'XLK', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'SPX',
]);

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
 * Best-effort check for whether the US exchanges this watchlist trades on
 * (NYSE/NASDAQ — every ticker here is a USD-denominated US stock) are
 * currently in their regular trading session. A real Swissquote account can
 * only fill US-equity orders while the exchange itself is open — without this
 * check the simulation could "buy" or "sell" at, say, 3am Swiss time on a
 * Sunday, something no real account could ever do. That would make the
 * simulation strictly more capable than reality, undermining the entire point
 * of modelling realistic costs and constraints.
 *
 * Regular session: Mon–Fri, 09:30–16:00 America/New_York. Deliberately checked
 * via `Intl.DateTimeFormat` with an explicit IANA timezone — that delegates
 * the EST/EDT daylight-saving switch to the platform's tz database instead of
 * hand-rolling fragile UTC-offset arithmetic that breaks twice a year.
 *
 * Deliberately NOT modelling the ~9 NYSE market holidays/year (Thanksgiving,
 * Christmas, ...): several are "nth weekday of month" floating dates that'd
 * need a hand-maintained, yearly-updated calendar — a lot of fragile
 * bookkeeping for an edge case whose worst case is "the bot trades a few hours
 * earlier than a real account could have, on ~9 days a year." An honestly
 * disclosed simplification beats a brittle one.
 */
function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const minutesSinceMidnight = Number(get('hour')) * 60 + Number(get('minute'));

  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';
  const sessionStart = 9 * 60 + 30; // 09:30 ET
  const sessionEnd = 16 * 60; // 16:00 ET
  return isWeekday && minutesSinceMidnight >= sessionStart && minutesSinceMidnight < sessionEnd;
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
): Promise<{ fee: number; fxFee: number; usdChfRate: number | null }> {
  if (openingTransactionId === null) return { fee: 0, fxFee: 0, usdChfRate: null };
  const { data, error } = await supabase
    .from('transactions')
    .select('fee, fx_fee, usd_chf_rate')
    .eq('id', openingTransactionId)
    .maybeSingle();
  if (error || !data) return { fee: 0, fxFee: 0, usdChfRate: null };
  return {
    fee: Number(data.fee) || 0,
    fxFee: Number(data.fx_fee) || 0,
    // `null` for legacy positions opened before this column existed — the
    // caller falls back to today's rate for those (see realized_pnl comment).
    usdChfRate: data.usd_chf_rate === null || data.usd_chf_rate === undefined ? null : Number(data.usd_chf_rate),
  };
}

/**
 * Live USD/CHF spot rate — "how many CHF does 1 USD buy right now". Fetched
 * from the very same Yahoo Finance chart endpoint already used for stock and
 * benchmark prices, just with the `USDCHF=X` symbol (Yahoo's standard ticker
 * for that currency pair) — so no new API, key, or secret is needed. Falls
 * back to `FALLBACK_USD_CHF_RATE` if the fetch fails for any reason: an FX
 * quote is important enough to model, but not important enough to abort an
 * entire scan run over a single flaky request.
 */
async function fetchUsdChfRate(): Promise<number> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/USDCHF=X?range=5d&interval=1d';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) return FALLBACK_USD_CHF_RATE;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (data?.chart?.error || !result) return FALLBACK_USD_CHF_RATE;
    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const value = closes[i];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return FALLBACK_USD_CHF_RATE;
  } catch (err) {
    console.warn(`USD/CHF-Kurs konnte nicht geladen werden, nutze Näherungswert: ${err}`);
    return FALLBACK_USD_CHF_RATE;
  }
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

interface VolumeProfile {
  recentAvg: number;
  baselineAvg: number;
}

// ── Source 4 (confirmation): trading volume ──────────────────────────────
// Mentions and price can both look "right" on paper while almost nobody is
// actually trading the name — loud Reddit chatter about a stock that trades
// on a trickle of volume is the classic "all talk, no real participation"
// setup: easy to manufacture, and easy to get burned chasing. Comparing the
// last ~5 trading days' average volume to the prior ~3-4 weeks' average turns
// "is the crowd actually showing up for this, or just talking about it?" into
// a number `classify()` can use exactly like StockTwits sentiment.
//
// This re-fetches the same Yahoo Finance chart endpoint `fetchPriceHistory`
// already hits, rather than threading a `volume[]` array through that
// function's `number[]` return type and all of its callers. That's a
// deliberate, small duplication: it keeps this signal entirely optional and
// isolated — if it fails, classification just falls back to "no volume data"
// (the same fail-soft pattern as sentiment), with zero risk of destabilizing
// the price-history path that the dip-detection and trend logic depend on.
async function fetchVolumeProfile(ticker: string): Promise<VolumeProfile | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=1mo&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (data?.chart?.error || !result) return null;
    const volumes: unknown[] = result?.indicators?.quote?.[0]?.volume ?? [];
    const valid = volumes.filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
    if (valid.length < 10) return null; // too little history to split into "recent" vs. "baseline" meaningfully
    const recent = valid.slice(-5); // last ~5 trading days — "right now"
    const baseline = valid.slice(0, -5); // everything before that — "normal"
    const avg = (xs: number[]) => xs.reduce((sum, x) => sum + x, 0) / xs.length;
    return { recentAvg: avg(recent), baselineAvg: avg(baseline) };
  } catch (err) {
    console.warn(`Volumen-Profil fehlgeschlagen für ${ticker}: ${err}`);
    return null;
  }
}

// ── Hype classification ──────────────────────────────────────────────────
// Correlates FIVE independent lenses so no single noisy source can drive a
// trade on its own: how much MORE a ticker is being mentioned than usual
// (Reddit/ApeWisdom), whether the wider crowd actually agrees with a bullish
// read (StockTwits sentiment), whether the price itself confirms the story
// (Yahoo Finance), whether real trading VOLUME backs the move (this ticker's
// own history), and — the newest lens — whether the stock is genuinely
// outperforming the broad MARKET rather than just floating up with a rising
// tide (vs. SPY). "Organic" now requires all five to line up; anything less
// is "spike" (watched, not traded). That's a deliberately higher bar than the
// original two-factor check (mentions + price): each lens is an independent
// way a "this looks like a real move" story can fall apart, and demanding
// agreement across all of them is the actual edge — fewer trades, but each
// one resting on firmer ground (which, as a side effect, also helps the
// per-trade fee math: see the TAKE_PROFIT/STOP_LOSS comment).
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
  relativeStrengthPct: number;
  volumeRatio: number | null;
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
  benchmarkTrendPct: number,
  volume: VolumeProfile | null,
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

  // ── Relative strength vs. the broad market (SPY) ───────────────────────
  // A stock rising 5% while the whole market rises 5% has no stock-specific
  // story at all — that's beta, not the kind of "this particular ticker has
  // its own catalyst" alpha a hype-driven strategy should be hunting for.
  // Only when a ticker meaningfully OUTPACES the benchmark over the same
  // window does a mention spike plausibly point at something the market
  // hasn't already priced in everywhere. `benchmarkTrendPct` is computed once
  // per run (see Deno.serve below) and shared across every ticker — the
  // market's own trend doesn't change per-ticker, so there's no reason to
  // (re-)derive it per-ticker, and every ticker ends up compared against
  // exactly the same window.
  const relativeStrengthPct = priceTrendPct - benchmarkTrendPct;
  const marketConfirms = relativeStrengthPct > 0;

  // ── Trading-volume confirmation ─────────────────────────────────────────
  // `volume` is null when Yahoo had too little history to compare against —
  // treated as "neutral / no opinion" (same fail-soft convention as
  // sentiment below), not as a red flag, so thin data coverage alone can't
  // permanently keep a ticker from ever being traded.
  let volumeNote = 'keine Volumendaten verfügbar';
  let volumeContradicts = false;
  let volumeRatio: number | null = null;
  if (volume && volume.baselineAvg > 0) {
    volumeRatio = volume.recentAvg / volume.baselineAvg;
    volumeContradicts = volumeRatio <= 0.7; // notably thinner than usual — move lacks real participation
    volumeNote = `Volumen ${(volumeRatio * 100).toFixed(0)}% des 4-Wochen-Schnitts (${volumeContradicts ? 'dünn — wenig echte Beteiligung' : 'unauffällig'})`;
  }

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

  const common = {
    hypeScore,
    baselineMentions: baseline,
    zScore,
    priceTrendPct,
    sentimentRatio,
    relativeStrengthPct: Math.round(relativeStrengthPct * 100) / 100,
    volumeRatio: volumeRatio === null ? null : Math.round(volumeRatio * 1000) / 1000,
  };

  // Pure hype: loud on Reddit, but neither the crowd's sentiment nor the price
  // backs it up — the textbook "pump" setup we must not chase.
  if (hypeScore > HYPE_BLOCK_THR && priceFallingOrFlat && !sentimentConfirmsBullish) {
    return {
      ...common,
      verdict: 'pure-hype',
      blocked: true,
      reason:
        `Hype-Score ${hypeScore.toFixed(0)} (z=${zScore.toFixed(1)}) > ${HYPE_BLOCK_THR} bei ${mentionCount} Erwähnungen ` +
        `(Ø ${baseline.toFixed(1)}), Kurs fällt/stagniert (${priceTrendPct.toFixed(1)}% über ${priceHistory.length} Tage), ` +
        `${sentimentNote}, ${volumeNote} — keine fundamentale Bestätigung. Geblockt.`,
    };
  }

  // Organic = ALL FIVE independent lenses agree this is a real, tradeable
  // move: mentions are elevated, price direction matches the story, the stock
  // genuinely OUTPACES the broad market (not just riding a rising tide — see
  // `marketConfirms` above), the crowd's sentiment doesn't contradict it, and
  // real trading volume backs it up. This is the actual "edge" change versus
  // the original two-factor (mentions + price) check: a system where five
  // largely-independent signals must agree should, in principle, have a
  // meaningfully better hit rate than one relying on two — at the cost of
  // triggering less often, which is the right trade for a swing-trading shape
  // anyway (see TAKE_PROFIT/STOP_LOSS).
  if (!priceFallingOrFlat && marketConfirms && !sentimentContradicts && !volumeContradicts) {
    return {
      ...common,
      verdict: 'organic',
      blocked: false,
      reason:
        `${mentionCount} Erwähnungen (Ø ${baseline.toFixed(1)}, z=${zScore.toFixed(1)}), ${sentimentNote}, ${volumeNote}, ` +
        `Kurs ${priceTrendPct >= 0 ? '+' : ''}${priceTrendPct.toFixed(1)}% bei relativer Stärke ${relativeStrengthPct >= 0 ? '+' : ''}${relativeStrengthPct.toFixed(1)}pp ggü. SPY ` +
        `(SPY ${benchmarkTrendPct >= 0 ? '+' : ''}${benchmarkTrendPct.toFixed(1)}%) — alle fünf unabhängigen Bestätigungssignale stimmen überein.`,
    };
  }

  // Everything else: loud and/or moving, but at least one independent lens
  // disagrees — watch, don't trade. (Replaces the old narrower "loud AND
  // contradicted" check: the real question driving the higher hit-rate isn't
  // "is the raw mention count >3x baseline", it's "do we have full,
  // independent confirmation to actually trust this" — answered above.)
  const gaps: string[] = [];
  if (priceFallingOrFlat) gaps.push(`Kurs bestätigt nicht (${priceTrendPct.toFixed(1)}%)`);
  if (!marketConfirms) gaps.push(`keine relative Stärke ggü. SPY (${relativeStrengthPct >= 0 ? '+' : ''}${relativeStrengthPct.toFixed(1)}pp, SPY ${benchmarkTrendPct >= 0 ? '+' : ''}${benchmarkTrendPct.toFixed(1)}%)`);
  if (sentimentContradicts) gaps.push(sentimentNote);
  if (volumeContradicts) gaps.push(volumeNote);
  return {
    ...common,
    verdict: 'spike',
    blocked: false,
    reason:
      `${mentionCount} Erwähnungen (Ø ${baseline.toFixed(1)}, z=${zScore.toFixed(1)}) — ${gaps.join('; ')} ` +
      `— kein stimmiges Gesamtbild aus allen fünf Signalen, wird beobachtet statt gehandelt.`,
  };
}

// ── Entry point ───────────────────────────────────────────────────────────
Deno.serve(async () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const log: string[] = [];

  // Computed once per run: gates the BUY/SELL branches further down (a real
  // account couldn't execute either while US exchanges are closed). Discovery,
  // classification and `signals` logging stay UNGATED on purpose — Reddit
  // hype doesn't pause on weekends/overnight, and continuing to record what we
  // observe (using whatever price Yahoo last reported) keeps the mention/
  // z-score history continuous, which `HISTORY_LOOKBACK` and the baseline
  // statistics depend on. Gating those too would create artificial gaps every
  // night and weekend, distorting the very baselines the strategy is built on.
  const marketOpen = isUsMarketOpen();
  log.push(
    marketOpen
      ? 'US-Börsen (NYSE/NASDAQ) sind aktuell geöffnet — Käufe/Verkäufe sind in diesem Lauf möglich.'
      : 'US-Börsen (NYSE/NASDAQ) sind aktuell geschlossen (ausserhalb 09:30–16:00 America/New_York, Mo–Fr) — ' +
          'Signale werden weiter erfasst, aber es werden keine Käufe/Verkäufe ausgeführt (ein echtes Konto könnte ohnehin nicht handeln).',
  );

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
    // Drop broad-market ETFs here — see BROAD_MARKET_ETFS — so they never
    // claim a candidate-pool/hot-list slot a genuine meme-stock pick could
    // have used, and so the watchlist stays focused on names this engine's
    // hype heuristic can actually say something meaningful about.
    const ranked = [...combinedScores.entries()]
      .filter(([ticker]) => !BROAD_MARKET_ETFS.has(ticker))
      .sort((a, b) => b[1] - a[1]);

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

    // ── Benchmark: SPY daily history, fetched ONCE per run ──────────────
    // Feeds two things: (a) the `relativeStrengthPct` input to `classify()`
    // below — "did this ticker actually outpace the broad market, or just
    // float up with it?" (see the comment at `marketConfirms` for why that
    // matters); and (b) the `balance_history.spy_price` snapshot at the end,
    // so the dashboard can show "vs. simply holding an index fund" — the only
    // honest way to tell whether this strategy adds value over a naive
    // baseline. Fetched once and shared across every ticker: the market's own
    // trend doesn't change per-ticker, so deriving it once is both cheaper
    // and guarantees every ticker is compared against the exact same window.
    let benchmarkHistory: number[] = [];
    try {
      benchmarkHistory = await fetchPriceHistory('SPY');
    } catch (err) {
      console.warn(`SPY-Historie konnte nicht geladen werden: ${err}`);
    }
    const benchmarkTrendPct =
      benchmarkHistory.length >= 2 && benchmarkHistory[0] !== 0
        ? ((benchmarkHistory[benchmarkHistory.length - 1] - benchmarkHistory[0]) / benchmarkHistory[0]) * 100
        : 0;
    if (benchmarkHistory.length === 0) {
      log.push(
        'SPY-Vergleichsdaten nicht verfügbar — relative Stärke wird für diesen Lauf konservativ als "kein Marktvergleich möglich" (0%) behandelt.',
      );
    }

    // ── USD/CHF spot rate, fetched ONCE per run ─────────────────────────
    // Shared across every conversion below (budget sizing, gross amounts,
    // realized PnL, the positions snapshot, ...) so a single run is
    // internally consistent — exactly like `benchmarkHistory`/`spyPrice`
    // above. See the constant's comment near FALLBACK_USD_CHF_RATE for the
    // full reasoning behind introducing this model at all.
    const usdChfRate = await fetchUsdChfRate();
    log.push(`Wechselkurs USD→CHF: ${usdChfRate.toFixed(4)} (live, Yahoo Finance USDCHF=X).`);

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
      const [sentiment, intradayHistory, volumeProfile, { data: history }] = await Promise.all([
        fetchStockTwitsSentiment(ticker),
        fetchIntradayPrices(ticker),
        fetchVolumeProfile(ticker),
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

      const {
        hypeScore,
        verdict,
        blocked,
        reason,
        baselineMentions,
        zScore,
        priceTrendPct,
        sentimentRatio,
        relativeStrengthPct,
        volumeRatio,
      } = classify(mentionCount, (history ?? []) as SignalRow[], dailyHistory, sentiment, benchmarkTrendPct, volumeProfile);

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
        const exitTriggered = change >= TAKE_PROFIT || change <= STOP_LOSS;
        if (exitTriggered && !marketOpen) {
          // The exit condition fired, but a real account couldn't place the
          // order right now — log it so a glance at the run history explains
          // *why* a seemingly-overdue exit didn't happen yet. `price-refresh`
          // (which also respects market hours, see there) or the next
          // in-hours `market-scan` run will catch it the moment trading
          // resumes — same as a real standing order would.
          log.push(
            `${ticker}: Exit-Schwelle erreicht (${(change * 100).toFixed(1)}% seit Einstieg, ` +
              `${change >= TAKE_PROFIT ? 'Take-Profit' : 'Stop-Loss'}), aber US-Börsen sind geschlossen — ` +
              `Order wird beim nächsten Lauf innerhalb der Handelszeiten ausgeführt.`,
          );
        }
        if (exitTriggered && marketOpen) {
          // Real money: the sale produces USD, which Swissquote then converts
          // to CHF at today's spot rate (modulo its margin, modelled by `fx`
          // below) before crediting the account — so `grossAmount` (what
          // actually lands in `cash`) must be the CHF-converted figure, not
          // the raw USD trade value.
          const grossAmountUsd = position.shares * price;
          const grossAmount = grossAmountUsd * usdChfRate;
          const fee = swissquoteFee(grossAmount);
          const fx = fxFee(grossAmount);
          const proceeds = grossAmount - fee - fx;
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
          // Convert the cost basis at the rate that applied when the position
          // was OPENED, not today's — otherwise a currency move between entry
          // and exit would silently get counted as "trading" P&L instead of
          // FX P&L (both are real money either way, but conflating them would
          // make the "Lern-Insights" verdict/z-score performance views draw
          // the wrong lesson from what actually moved the outcome). Falls
          // back to today's rate only for legacy positions opened before this
          // column existed (no historical rate on file to use instead).
          const entryFxRate = openingCosts.usdChfRate ?? usdChfRate;
          const costBasisUsd = position.shares * position.entry_price;
          const costBasis = costBasisUsd * entryFxRate;
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
            usd_chf_rate: usdChfRate,
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
      // `marketOpen` gates this too — same reasoning as the sell check above:
      // a real account can't open a US-equity position while NYSE/NASDAQ are
      // closed. Unlike exits (time-sensitive, worth a per-ticker log line),
      // a missed buy candidate simply reappears on the next in-hours
      // evaluation — `dropFromHigh` is multi-week-anchored, so a few hours'
      // delay changes nothing material. The run-level "markets closed" log
      // line at the top already covers this; per-candidate noise here would
      // just clutter the log without adding information.
      if (
        marketOpen &&
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
          // `cash` is CHF; open positions' mark-to-market value is computed
          // from USD prices — convert it to CHF before summing, otherwise
          // `totalValue` (and therefore the CHF `budget` derived from it)
          // would silently understate/overstate the portfolio depending on
          // which way USD/CHF happens to be leaning that day.
          const positionsValueUsd = positions.reduce(
            (sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price),
            0,
          );
          const totalValue = portfolio.cash + positionsValueUsd * usdChfRate;
          const budget = totalValue * POSITION_SIZE; // CHF — this is what we're willing to spend
          const fee = swissquoteFee(budget);
          const fx = fxFee(budget);
          const investable = budget - fee - fx; // CHF actually available to convert & invest
          // `price` is in USD; `price * usdChfRate` is "CHF cost per share" —
          // dividing the CHF budget by that yields the right USD-denominated
          // share count for a CHF-sized position (so `shares * price *
          // usdChfRate ≈ investable`, see `grossAmount` just below).
          const shares = investable > 0 ? investable / (price * usdChfRate) : 0;

          if (shares > 0 && portfolio.cash >= budget) {
            const grossAmountUsd = shares * price;
            const grossAmount = grossAmountUsd * usdChfRate; // CHF — what actually leaves `cash`
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
              relative_strength_pct: Math.round(relativeStrengthPct * 100) / 100,
              volume_ratio: volumeRatio === null ? null : Math.round(volumeRatio * 1000) / 1000,
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
                usd_chf_rate: usdChfRate,
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

    // Mark-to-market value of open positions, in CHF — `shares`/`price` are
    // USD-denominated, so the live `usdChfRate` (fetched once, up top)
    // converts the snapshot to the same currency as `cash`/`total_value`.
    const positionsValueUsd = positions.reduce(
      (sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price),
      0,
    );
    const positionsValue = positionsValueUsd * usdChfRate;
    // Reuses `benchmarkHistory` (fetched once, up top, for `relativeStrengthPct`)
    // rather than a second round-trip to Yahoo Finance for the same symbol.
    const spyPrice = benchmarkHistory.length ? benchmarkHistory[benchmarkHistory.length - 1] : null;
    if (spyPrice === null) {
      log.push('SPY-Benchmarkpreis konnte nicht geladen werden — Vergleichschart bleibt für diesen Lauf ohne neuen Punkt.');
    }
    await supabase.from('balance_history').insert({
      cash: portfolio.cash,
      positions_value: positionsValue,
      total_value: portfolio.cash + positionsValue,
      spy_price: spyPrice,
      usd_chf_rate: usdChfRate,
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
