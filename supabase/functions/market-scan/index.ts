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

// ── Two-level exit design (intelligent sell/hold) ─────────────────────────
// An open position has THREE exit triggers, not the old single stop:
//
//   1. TAKE_PROFIT (+20% from entry)   — unconditional, lock the win.
//   2. HARD_STOP   (-8% from entry)    — unconditional capital floor. This is
//      the ONLY true risk limit; it always fires regardless of verdict.
//   3. Trailing stop (price ≤ peak × (1+STOP_LOSS), i.e. -6% below the highest
//      price seen since entry) — but SUPPRESSED while the position is still
//      "buy-eligible" (organic + in our dip range). Rationale: it makes no
//      sense to sell on a trailing stop only to have the buy-check re-open the
//      exact same dip on the next scan, paying a double round-trip fee. So the
//      trailing stop only sells when momentum broke AND we would NOT re-buy —
//      i.e. near the highs (no longer a dip → lock profit) or once the thesis
//      flips away from `organic` (then the next trailing trigger exits the
//      broken thesis). See the sell-check below for the `wouldBuyNow` gate.
//      This is why the post-sell cooldown is no longer needed: the churn path
//      (sell-then-immediately-rebuy) can't occur — we HOLD instead of selling.
//
// Fee math (unchanged round-trip tax, worst-case loss now the -8% HARD_STOP):
//   one-way cost ≈ 30/2400 + 0.0095   ≈ 1.25% + 0.95%  ≈  2.2%
//   round-trip   ≈ 2 × one-way cost                    ≈  4.4%
//   net win  ≈ TAKE_PROFIT - 0.044  =  0.20 - 0.044  ≈ +15.6%
//   net loss ≈ HARD_STOP   - 0.044  = -0.08 - 0.044  ≈ -12.4%
//   breakeven hit rate = |net loss| / (net win + |net loss|) ≈ 44%
//
// ~44% is still a realistic bar for a heuristic with a genuine edge. The
// wider -8% floor (vs the old -6%) is a deliberate trade: it buys patience so
// an organic dip isn't churned out on noise, while each avoided churn saves a
// full ~4.4% round trip — comfortably more than the extra 2% of drawdown the
// wider floor risks. The trailing stop (level 3) still protects profit near
// the highs, where suppression doesn't apply (no longer a dip to re-buy).
const TAKE_PROFIT = 0.20; // unconditional take-profit, % gain from entry
const STOP_LOSS = -0.06; // trailing-stop DISTANCE below the since-entry peak (level 3)
const HARD_STOP = -0.08; // unconditional capital floor, % loss from entry (level 2)

// Trimmed from 5 to 3 alongside the POSITION_SIZE increase (0.12 → 0.24) —
// see the comment there: fewer, larger slots in exchange for each trade's
// near-flat brokerage commission costing a much smaller percentage. At 0.24
// each, 3 slots cap invested capital at ~72% (vs. the previous 5 × 0.12 =
// 60%), leaving a comparable cash buffer for fees/slippage/new candidates.
const MAX_POSITIONS = 3;
const HYPE_BLOCK_THR = 65; // hype score above which a ticker can be blocked

// ── Measure 1: Near-miss dip buffer ──────────────────────────────────────
// A ticker sitting 3.7% below its multi-week high with full organic
// confirmation is MORE interesting than one that just scraped -4% with weak
// signals. Hard gates produce cliff effects: the difference between -3.99%
// and -4.01% shouldn't be binary. Instead we open a REDUCED position for
// dips within NEAR_DIP_BUFFER of the threshold — expressing "lower
// conviction" via size rather than a flat rejection.
//
// The reduced size is upgraded back to full if the ticker has been
// classified 'organic' in at least CONSECUTIVE_ORGANIC_THRESHOLD prior
// scans in a row (Measure 3) — repeated confirmation is strong evidence of
// a genuine trend, not a one-scan noise spike.
const NEAR_DIP_BUFFER = 0.01;            // 1 pp above DIP_THRESH qualifies — but only with streak confirmation
const CONSECUTIVE_ORGANIC_THRESHOLD = 2; // min consecutive prior organic scans required for a near-miss buy

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
//
// Originally tuned to "28 rows ≈ one full week" at a 4-scans/day, round-the-
// clock cadence (4 × 7 = 28) — long enough to span a complete weekday/weekend
// cycle, short enough that a newly discovered ticker builds a representative
// baseline within about a week. Brings this in line with the rest of the
// engine's "multi-week-minded" swing-trading tuning (the ~30-day price
// history, the ~3-4-week volume baseline, the multi-week "recent high").
//
// The cadence changed (see `market-scan-during-trading-hours` — now 3 scans
// on each TRADING day only, no weekend runs at all: scanning while NYSE/
// NASDAQ is closed could never produce an actionable signal anyway, see
// `isUsMarketOpen`). At 3 × 5 = 15 rows/week, the OLD value of 28 would now
// span ≈ 1.9 weeks rather than 1 — not wrong, just a different baseline
// horizon than the one the original reasoning settled on. Lowered to 15 to
// preserve that original "~1 week, ~1 trading week of samples" intent rather
// than silently drifting to a longer one as a side effect of an unrelated
// scheduling change. (The "spans a weekday/weekend cycle" reasoning no longer
// applies either way — there IS no weekend data to span anymore; every row in
// the baseline is now a trading-day sample, which if anything makes the
// baseline MORE representative of "normal" Reddit chatter, not less.)
const HISTORY_LOOKBACK = 20; // how many past signal rows to use for the hype baseline
// 4 scans/day × 5 trading days/week = 20 rows ≈ 1 trading week of samples.
// (Was 15 when the schedule was 3 scans/day; raised to match the new 14:30 UTC
// market-open scan added alongside this change.)

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
//
// NOTE: this is a DISCOVERY-time filter, not a buy-time guarantee — it's a
// short hand-curated list of well-known broad-market/sector ETFs, and
// leveraged/thematic ones (TQQQ, SOXL, ARKQ, ...) aren't on it. The actual
// "never buy an ETF" guarantee lives in the buy check / `wouldHaveBought`
// below (`instrumentInfoByTicker.get(ticker)?.isEtf !== true`), which is
// grounded in Yahoo's own `instrumentType` classification — see
// `fetchInstrumentInfo` and trading_schema_v7_etf_flag.sql. Two separate
// mechanisms for two separate jobs: this list keeps watchlist slots focused
// on tickers worth evaluating at all; the `is_etf` gate is the safety net
// that holds regardless of which tickers make it onto that list.
//
// SECONDARY USE — static `is_etf` backfill safety net (see the
// `staleEtfTickers` block in the watchlist-sync phase below): every entry
// here is, by definition, a hand-confirmed real ETF, which makes this list
// dual-purpose as an authoritative override for legacy rows that the normal
// Yahoo-driven backfill can structurally never reach (because THIS VERY
// FILTER keeps them from ever being re-evaluated again — see that block's
// comment for the full chain of reasoning).
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
  /** See `fetchInstrumentInfo`/`trading_schema_v7_etf_flag.sql` — `null` until
   *  this ticker has been (re-)evaluated since that migration landed. */
  is_etf: boolean | null;
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
  /** Highest price seen since this position was opened. Trailing stop fires at
   *  high_since_entry × (1 + STOP_LOSS). Updated in-place whenever price
   *  exceeds the stored value. Pre-v14 rows seeded at entry_price. */
  high_since_entry: number;
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
//
// `meta.instrumentType` ("EQUITY" vs "ETF" vs ...) and `meta.longName` ride
// along in the SAME response — see `fetchInstrumentInfo` below, which is the
// real entry point now; this is kept as a thin wrapper purely so the
// SPY-benchmark call site (which only ever wants the closes) doesn't have to
// unwrap an object it has no use for.
async function fetchPriceHistory(ticker: string): Promise<number[]> {
  return (await fetchInstrumentInfo(ticker)).closes;
}

/** Daily closes plus the bits of Yahoo's `meta` block the watchlist needs to
 *  tell stocks and ETFs apart (see `is_etf` in trading_schema_v7_etf_flag.sql)
 *  and to fill in a human-readable name for tickers the seed list didn't cover
 *  — all from data already being fetched, no extra request. */
interface InstrumentInfo {
  closes: number[];
  /** `true`/`false` when Yahoo states `instrumentType` outright (authoritative
   *  — "EQUITY" → false, "ETF" → true); `null` when that field is missing, so
   *  callers can tell "confirmed not an ETF" from "Yahoo didn't say" and avoid
   *  e.g. blocking a legitimate buy on momentarily-incomplete metadata. */
  isEtf: boolean | null;
  /** `longName` (falls back to `shortName`) — e.g. "Invesco QQQ Trust" — used
   *  to opportunistically backfill `watchlist.name` for tickers that were
   *  auto-discovered (and so only ever got a bare ticker symbol). */
  name: string | null;
}

async function fetchInstrumentInfo(ticker: string): Promise<InstrumentInfo> {
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
  const meta = result?.meta;
  const instrumentType = typeof meta?.instrumentType === 'string' ? meta.instrumentType : null;
  const name =
    typeof meta?.longName === 'string'
      ? meta.longName
      : typeof meta?.shortName === 'string'
        ? meta.shortName
        : null;
  return {
    closes: valid.slice(-30), // last ~30 trading days, oldest first
    isEtf: instrumentType === null ? null : instrumentType === 'ETF',
    name,
  };
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

// ── Source 5 (confirmation): FinViz mainstream-news presence ─────────────
// Free, no API key. Fetches finviz.com/news.ashx (the general market news
// feed) and extracts every stock ticker referenced via the /stock?t=TICKER
// href pattern. The resulting Set is stored as `finviz_news` on each signal
// row — informative only, no effect on buy/sell logic.
//
// Design decision: this is deliberately NOT a gate or a hard classification
// lens. The temporal relationship between Reddit hype and mainstream coverage
// is complex and asymmetric:
//   • Meme-stock pumps: Reddit leads by 1–3 days, news follows AFTER the move.
//     Gating on "no news = no buy" here would filter out the earliest and most
//     profitable entries.
//   • Catalyst-driven moves: news breaks first, Reddit piles in hours later.
//     Here news-backed hype IS more reliable — there's a real fundamental
//     reason behind the price action.
// Until we have enough closed trades to empirically measure which pattern
// dominates our specific dataset, we store the flag and let data accumulate.
// The planned follow-up SQL (see migration v12 comment) is:
//   SELECT finviz_news, avg(realized_pnl), count(*) FROM transactions t
//   JOIN signals s ON ... GROUP BY finviz_news;
async function fetchFinVizNewsTickers(): Promise<Set<string>> {
  const url = 'https://finviz.com/news.ashx';
  try {
    const res = await fetch(url, {
      headers: {
        // A realistic browser UA reduces the chance of a bot-check redirect.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) {
      console.warn(`FinViz News fetch fehlgeschlagen: ${res.status} — Badge-Spalte bleibt für diesen Lauf leer.`);
      return new Set();
    }
    const html = await res.text();
    const tickers = new Set<string>();
    // FinViz embeds stock tickers as /stock?t=TICKER in anchor href attributes.
    // Regex anchored at the known prefix to avoid false matches elsewhere in the HTML.
    const tickerRe = /\/stock\?t=([A-Z]{1,5})\b/g;
    let m: RegExpExecArray | null;
    while ((m = tickerRe.exec(html)) !== null) {
      const sym = m[1];
      if (!TICKER_STOPWORDS.has(sym)) tickers.add(sym);
    }
    return tickers;
  } catch (err) {
    console.warn(`FinViz News fetch Fehler: ${err} — Badge-Spalte bleibt für diesen Lauf leer.`);
    return new Set();
  }
}

// ── Source 6 (macro gate): CNN Fear & Greed Index ────────────────────────
// Free, keyless JSON endpoint from CNN's own data-viz CDN. Returns a 0–100
// score: 0 = "Extreme Fear", 100 = "Extreme Greed". The engine uses it as a
// hard BUY gate: score < 40 ("Fear" territory) → no new positions opened for
// this run, existing stop-loss/take-profit levels continue unchanged. The
// reasoning: when the broad market is pricing in elevated fear, even genuinely
// "organic" single-stock hype is more likely to get swept up in a general
// sell-off than to deliver the swing-trading gains the strategy is sized for.
// It's a blunt instrument (the score has nothing to do with individual ticker
// quality) but it's cheap, signal-independent, and wrong in the right direction
// — the cost of a missed entry during a fearful market is much lower than the
// cost of an entry that gets stopped out by macro panic two days later.
async function fetchFearAndGreed(): Promise<{ score: number; label: string } | null> {
  const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`CNN Fear & Greed fetch fehlgeschlagen: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const score = data?.fear_and_greed?.score;
    const rating = data?.fear_and_greed?.rating;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      console.warn('CNN Fear & Greed: unerwartetes Antwortformat — Score nicht gefunden.');
      return null;
    }
    return { score: Math.round(score), label: typeof rating === 'string' ? rating : '' };
  } catch (err) {
    console.warn(`CNN Fear & Greed fetch Fehler: ${err}`);
    return null;
  }
}

// ── Source 6 (informative): Yahoo Finance US Trending Tickers ────────────
// Free, keyless endpoint that returns which tickers are trending on YF right
// now. Used as an INFORMATIVE-ONLY badge on signal rows — stored as a boolean
// flag (`yf_trending`) on each `signals` row so the dashboard can show "this
// ticker is also hot on YF right now". No effect on buy/sell logic (yet):
// the set of YF-trending tickers overlaps heavily with our ApeWisdom/Reddit
// discovery, so it would add little incremental edge as a filter — but as a
// visual corroboration signal ("Reddit AND Yahoo both see it") it adds genuine
// context for a human reviewing the watchlist.
async function fetchYFTrending(): Promise<Set<string>> {
  const url = 'https://query1.finance.yahoo.com/v1/finance/trending/US';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) {
      console.warn(`YF Trending fetch fehlgeschlagen: ${res.status}`);
      return new Set();
    }
    const data = await res.json();
    const quotes: unknown[] = data?.finance?.result?.[0]?.quotes ?? [];
    const tickers = new Set<string>();
    for (const q of quotes) {
      const sym = (q as Record<string, unknown>)?.symbol;
      if (typeof sym === 'string' && sym) tickers.add(sym.toUpperCase());
    }
    return tickers;
  } catch (err) {
    console.warn(`YF Trending fetch Fehler: ${err}`);
    return new Set();
  }
}

// ── ntfy push notifications ───────────────────────────────────────────────
// Sends a push notification via ntfy.sh (https://ntfy.sh) — a free, keyless
// pub/sub notification service. The user subscribes to their chosen topic in
// the ntfy mobile app; the Edge Function POSTs to that same topic URL.
//
// Topic stored as a Vault secret: `ntfy_topic`.
// If the secret is absent (not yet set up), notifications are silently skipped
// — fail-open so a missing secret never breaks a trading run.
//
// Priority scale:  1=min  2=low  3=default  4=high  5=urgent
// Tags: emoji short-codes understood by the ntfy app (e.g. "green_circle").
async function sendNtfy(
  topic: string,
  title: string,
  message: string,
  priority: 1 | 2 | 3 | 4 | 5 = 3,
  tags: string[] = [],
): Promise<void> {
  try {
    // Use header-based format with text/plain body — ntfy treats application/json
    // bodies as file attachments rather than messages (confirmed in testing).
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Title': title,
        'X-Priority': String(priority),
        ...(tags.length ? { 'X-Tags': tags.join(',') } : {}),
      },
      body: message,
    });
  } catch (err) {
    // Non-critical: a notification failure must never interrupt the trade run.
    console.warn(`ntfy notification failed (non-critical): ${err}`);
  }
}

// ── Push notification log ────────────────────────────────────────────────
// Persists every sent notification to `push_notifications` so the dashboard
// Notification Center can show a full history without a separate polling setup.
// Non-critical: called AFTER sendNtfy(), failure never affects the trade run.
async function logNotification(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  title: string,
  message: string,
  topic: string,
  priority: number,
  tags: string[],
  eventType: string | null,
  ticker: string | null,
): Promise<void> {
  try {
    await supabase.from('push_notifications').insert({
      title,
      message,
      topic,
      priority,
      tags,
      event_type: eventType,
      ticker,
    });
  } catch (err) {
    console.warn(`push notification log failed (non-critical): ${err}`);
  }
}

// ── Measure 3: Consecutive organic confirmation ──────────────────────────
// Counts how many scans PRIOR to the current run had verdict = 'organic' for
// this ticker in an unbroken streak. The current run's signal is already in
// the DB (inserted above the buy check), so we skip index 0 of the result.
//
// Used to upgrade near-miss entries (Measure 1) from half to full position
// size: if a ticker has been organic for 2+ consecutive scans, that's
// sustained, multi-hour confirmation — not a single-scan noise spike.
//
// Returns 0 on any DB error (fail-safe: don't let a query failure prevent
// the rest of the buy logic from running).
// deno-lint-ignore no-explicit-any
async function getConsecutiveOrganicCount(supabase: any, ticker: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('signals')
      .select('verdict')
      .eq('ticker', ticker)
      .order('scanned_at', { ascending: false })
      .limit(CONSECUTIVE_ORGANIC_THRESHOLD + 3);
    if (error || !data || data.length <= 1) return 0;
    // data[0] = the signal just inserted for THIS run → skip it.
    let count = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i].verdict === 'organic') count++;
      else break;
    }
    return count;
  } catch {
    return 0;
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

  // ntfy topic: set once in Supabase Vault as `ntfy_topic`. If absent,
  // all sendNtfy calls below are no-ops — trade logic is never affected.
  const ntfyTopic = Deno.env.get('NTFY_TOPIC') ?? '';

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
    // Collected alongside the price history (same fetch, no extra request) so
    // the watchlist sync below can write `is_etf`/`name` from real Yahoo data
    // — see `InstrumentInfo` and trading_schema_v7_etf_flag.sql.
    const instrumentInfoByTicker = new Map<string, InstrumentInfo>();
    for (const [symbol] of ranked.slice(0, CANDIDATE_POOL_SIZE)) {
      if (hotPriceHistory.size >= HOT_LIST_SIZE) break;
      if (hotPriceHistory.has(symbol)) continue;
      try {
        const info = await fetchInstrumentInfo(symbol);
        if (info.closes.length > 0) {
          hotPriceHistory.set(symbol, info.closes);
          instrumentInfoByTicker.set(symbol, info);
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
      .select('ticker, name, active, is_etf');
    if (watchlistError) throw watchlistError;
    const existingByTicker = new Map(
      ((existingWatchlist ?? []) as WatchlistRow[]).map((w) => [w.ticker, w]),
    );

    // Static safety net for `is_etf` on well-known broad-market/sector ETFs —
    // closes a real "stuck at null forever" gap that the opportunistic
    // Yahoo-driven backfill below cannot reach on its own:
    //
    //   `BROAD_MARKET_ETFS` tickers are filtered OUT at discovery (see that
    //   constant's comment), so a legacy row like SPY/QQQ/VOO — discovered
    //   back before that filter existed — is `active = false`, has no open
    //   position, and therefore never lands in `instrumentInfoByTicker`
    //   (which only ever covers `hotPriceHistory` ∪ `positionTickers`). The
    //   per-ticker backfill loop a few dozen lines down can only patch rows
    //   it has a fresh Yahoo read for — so these specific rows would sit at
    //   `is_etf: null` ("we don't know yet") indefinitely, even though we
    //   very much DO know: that's the entire reason they're on this list.
    //
    //   (For the record: Yahoo's own `instrumentType` actually classifies
    //   both correctly as "ETF" too — verified live — so this isn't working
    //   around bad upstream data either. It's purely an "this row can never
    //   be reached by the normal path" problem, and a one-line direct UPDATE
    //   from data we already hand-curated and trust is the simplest fix —
    //   no extra Yahoo Finance call, no expansion of what gets evaluated.)
    const staleEtfTickers = [...existingByTicker.values()]
      .filter((w) => w.is_etf === null && BROAD_MARKET_ETFS.has(w.ticker))
      .map((w) => w.ticker);
    if (staleEtfTickers.length > 0) {
      await supabase.from('watchlist').update({ is_etf: true }).in('ticker', staleEtfTickers);
      for (const ticker of staleEtfTickers) {
        existingByTicker.get(ticker)!.is_etf = true; // keep in-memory copy consistent for the rest of this run
      }
      log.push(
        `${staleEtfTickers.join(', ')}: nachträglich als ETF eingestuft (bekannte Index-/Sektor-ETFs, ` +
          `seit der BROAD_MARKET_ETFS-Filterung nicht mehr neu bewertet — siehe Kommentar im Code).`,
      );
    }

    for (const ticker of hotPriceHistory.keys()) {
      const existing = existingByTicker.get(ticker);
      const info = instrumentInfoByTicker.get(ticker);
      if (!existing) {
        await supabase
          .from('watchlist')
          .insert({ ticker, active: true, name: info?.name ?? null, is_etf: info?.isEtf ?? null });
        log.push(`${ticker}: neu entdeckt und zur Watchlist hinzugefügt${info?.isEtf ? ' (ETF)' : ''}.`);
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

    // ── Fear & Greed + YF Trending, fetched in parallel ─────────────────
    // Both are "once per run" values — F&G sets a potential buy-gate, YF
    // Trending produces the per-ticker badge. Running them together avoids
    // serialising two more round trips into an already-long scan loop.
    const [fearGreedResult, yfTrendingSet, finVizNewsSet] = await Promise.all([
      fetchFearAndGreed(),
      fetchYFTrending(),
      fetchFinVizNewsTickers(),
    ]);
    const fearGreedScore: number | null = fearGreedResult !== null ? fearGreedResult.score : null;

    // Hard buy-gate: score below 40 ("Fear") → skip ALL new position openings
    // for this run. Sell/stop-loss/take-profit checks continue unchanged —
    // the gate only prevents ADDING new risk when the market is in fear mode.
    const buyGateActive = fearGreedScore !== null && fearGreedScore < 40;

    if (fearGreedScore !== null) {
      log.push(
        `CNN Fear & Greed: ${fearGreedScore} (${fearGreedResult!.label})` +
          (buyGateActive
            ? ` — Kauf-Stop aktiv (Score < 40). Keine neuen Positionen in diesem Lauf.`
            : ` — Score ≥ 40, neue Käufe erlaubt.`),
      );
    } else {
      log.push('CNN Fear & Greed: nicht verfügbar — Kauf-Stop nicht aktiv (fail-open).');
    }
    log.push(`YF Trending (US): ${yfTrendingSet.size} Ticker trending${yfTrendingSet.size > 0 ? ` (${[...yfTrendingSet].slice(0, 10).join(', ')}${yfTrendingSet.size > 10 ? ', …' : ''})` : ''}.`);
    log.push(`FinViz News: ${finVizNewsSet.size} Ticker in Mainstream-Schlagzeilen${finVizNewsSet.size > 0 ? ` (${[...finVizNewsSet].slice(0, 10).join(', ')}${finVizNewsSet.size > 10 ? ', …' : ''})` : ' (oder Fetch blockiert — Badge bleibt leer, kein Handlungseinfluss).'}.`);

    // ── Phase 3: evaluate every hot ticker plus anything we still hold ──
    const evaluationSet = new Map<string, number[]>(hotPriceHistory);
    for (const ticker of positionTickers) {
      if (!evaluationSet.has(ticker)) {
        try {
          // Same combined fetch as discovery — keeps `instrumentInfoByTicker`
          // complete for the buy-gate below AND lets a held position's row
          // get its `is_etf`/`name` backfilled too (it can't be an ETF, the
          // buy-gate would have refused it, but `name` is still worth having).
          const info = await fetchInstrumentInfo(ticker);
          evaluationSet.set(ticker, info.closes);
          instrumentInfoByTicker.set(ticker, info);
        } catch {
          evaluationSet.set(ticker, []);
        }
      }
    }
    // Opportunistic backfill for EVERY ticker we have a fresh read for —
    // including held positions that aren't on the hot list. `is_etf`/`name`
    // come straight from Yahoo's own classification (real data, not a guess),
    // so unlike the v6 "missed opportunities" columns it's fine — and useful
    // — to fill in whatever a row is still missing, rather than leaving every
    // pre-v7 row stuck at "unknown" forever. Consolidated here (after BOTH
    // the discovery and held-position fetches) so each ticker is patched once.
    for (const [ticker, info] of instrumentInfoByTicker) {
      const existing = existingByTicker.get(ticker);
      if (!existing) continue;
      const patch: Record<string, unknown> = {};
      if (existing.is_etf === null && info.isEtf !== null) patch['is_etf'] = info.isEtf;
      if (existing.name === null && info.name) patch['name'] = info.name;
      if (Object.keys(patch).length > 0) {
        await supabase.from('watchlist').update(patch).eq('ticker', ticker);
        Object.assign(existing, patch); // keep in-memory copy consistent for the rest of this run
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

      // Hoisted up from the buy-check below (where only this ran before) so
      // EVERY evaluated ticker gets a `drop_from_high_pct` on its `signals`
      // row — not just the ones that happened to qualify for a buy. Without
      // that, you can't later tell "verdict wasn't organic" apart from
      // "verdict was fine, but the dip wasn't deep enough" when reviewing
      // tickers that weren't bought (see the "Verpasste Chancen" tab and
      // trading_schema_v6_missed_opportunities.sql for why that distinction
      // matters). Same reasoning applies to `position`: known from the start
      // of the loop, no need to wait until the sell-check to look it up.
      const position = positions.find((p) => p.ticker === ticker);
      const recentHigh = Math.max(...dailyHistory);
      const dropFromHigh = (price - recentHigh) / recentHigh;

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

      // ── "Verpasste Chancen" bookkeeping ──────────────────────────────────
      // `wouldHaveBought` mirrors the real buy-check below MINUS the
      // `positions.length < MAX_POSITIONS` capacity gate — i.e. "every other
      // condition for opening a new position here was met". `skippedForCapacity`
      // narrows that down to the one case worth reviewing later: the heuristic
      // wanted to act and the ONLY thing that stopped it was a full portfolio.
      // (Tickers we already hold, or where the verdict/dip didn't qualify, are
      // deliberately excluded from `wouldHaveBought` — those aren't "missed
      // opportunities" in the interesting sense, see
      // trading_schema_v6_missed_opportunities.sql for the full reasoning.)
      // Base buy-eligibility — everything except the capacity gate and the F&G
      // gate. Used as the shared foundation for both "skipped" flags below so
      // neither has to repeat the full condition list.
      // Dip classification — used both for buyEligible tracking and the buy check.
      const isFullDip  = dropFromHigh <= DIP_THRESH;
      const isNearMiss = !isFullDip && dropFromHigh <= DIP_THRESH + NEAR_DIP_BUFFER;

      const buyEligible =
        marketOpen &&
        !position &&
        verdict === 'organic' &&
        instrumentInfoByTicker.get(ticker)?.isEtf !== true &&
        (isFullDip || isNearMiss);

      // `wouldHaveBought` — eligible AND F&G gate not blocking AND capacity free.
      // Used for the "Verpasste Chancen" tab (capacity-only misses).
      const wouldHaveBought = buyEligible && !buyGateActive;
      const skippedForCapacity = wouldHaveBought && positions.length >= MAX_POSITIONS;

      // `skippedForFearGreed` — eligible but ONLY the F&G gate stopped it.
      // Deliberately excludes capacity blocks so the two "why didn't we buy"
      // reasons stay orthogonal and independently queryable in the DB.
      const skippedForFearGreed = buyEligible && buyGateActive;

      const { error: signalError } = await supabase.from('signals').insert({
        ticker,
        price,
        mention_count: mentionCount,
        hype_score: hypeScore,
        verdict,
        blocked,
        reason,
        drop_from_high_pct: Math.round(dropFromHigh * 1000) / 10,
        would_have_bought: wouldHaveBought,
        skipped_for_capacity: skippedForCapacity,
        // Persist the StockTwits crowd-sentiment ratio on EVERY signal row
        // (not just buys' `signal_snapshot`, as before v9) — see
        // trading_schema_v9_sentiment_column.sql for why the watchlist needed
        // this to show "what does the crowd think about this ticker right
        // now", independent of whether a trade happened. `null` is preserved
        // as-is (honest "fewer than 5 tagged messages" — see `classify`),
        // never coerced to 0, which would misrepresent thin data as neutral.
        sentiment_ratio: sentimentRatio === null ? null : Math.round(sentimentRatio * 1000) / 1000,
        // v10: macro context at scan time — see trading_schema_v10_fear_greed_yf_trending.sql
        fear_greed_score: fearGreedScore,
        yf_trending: yfTrendingSet.has(ticker),
        // v11: gate-logging — was this a buy the engine WOULD have made, if not
        // for the F&G score being below 40? See trading_schema_v11.
        skipped_for_fear_greed: skippedForFearGreed,
        // v12: mainstream-news presence badge (informative only — see fetchFinVizNewsTickers)
        finviz_news: finVizNewsSet.has(ticker),
      });
      if (signalError) throw signalError;
      log.push(`${ticker}: ${verdict} (hype=${hypeScore.toFixed(0)}, mentions=${mentionCount}, price=${price})`);

      if (blocked) {
        portfolio.blocked_count += 1;
        portfolio.blocked_capital += portfolio.cash * POSITION_SIZE;
        continue;
      }

      // ── Sell check: existing position hit take-profit or trailing stop ──
      // (`position` is now hoisted above, alongside `dropFromHigh` — see the
      // comment there for why both moved up.)
      if (position) {
        // ── Trailing stop: update the running high first ──────────────────
        // The trailing stop fires at high_since_entry × (1 + STOP_LOSS),
        // i.e. −6% from the HIGHEST price seen since entry — not from entry
        // itself. This locks in profit as the position runs up: a position
        // at +14% can't fall back below +8% before triggering an exit, unlike
        // the old fixed stop which would have let it ride all the way back to
        // −6% from entry. Take-profit is still anchored to entry_price (a
        // fixed +20%-from-entry target makes more sense than a moving one that
        // can never be "reached" if the stock keeps climbing).
        const newHigh = Math.max(position.high_since_entry, price);
        if (newHigh > position.high_since_entry) {
          await supabase.from('positions').update({ high_since_entry: newHigh }).eq('id', position.id);
          position.high_since_entry = newHigh;
        }

        const changePct = (price - position.entry_price) / position.entry_price;
        const trailingStopPrice = newHigh * (1 + STOP_LOSS); // e.g. newHigh × 0.94

        // ── Intelligent exit gate (see the two-level design at HARD_STOP) ────
        // `wouldBuyNow` reuses the exact buy-eligibility predicate (verdict +
        // dip + not-ETF) MINUS the `!position` check — i.e. "would the engine
        // re-open this position at the current price?". It is deliberately a
        // touch more lenient than the buy-check (no consecutive-organic
        // confirmation for near-misses): entering on a one-scan fluke is
        // expensive, but HOLDING one extra scan costs nothing, so the bar to
        // keep a position is lower than the bar to open one.
        const wouldBuyNow =
          verdict === 'organic' &&
          instrumentInfoByTicker.get(ticker)?.isEtf !== true &&
          (isFullDip || isNearMiss);

        const hitTakeProfit = changePct >= TAKE_PROFIT; // +20% — unconditional
        const hitHardStop = changePct <= HARD_STOP; // -8% from entry — unconditional
        const hitTrailing = price <= trailingStopPrice; // -6% below since-entry peak
        // The trailing stop only sells if we would NOT re-buy here — otherwise
        // we'd churn (sell then re-open the same dip, double round-trip fee).
        const exitTriggered = hitTakeProfit || hitHardStop || (hitTrailing && !wouldBuyNow);

        const exitReason: 'take-profit' | 'hard-stop' | 'trailing-stop' = hitTakeProfit
          ? 'take-profit'
          : hitHardStop
            ? 'hard-stop'
            : 'trailing-stop';

        // Momentum broke, but the entry thesis is intact (organic + still in
        // our dip range) and we're above the hard floor → HOLD instead of
        // selling. Logged so the run history explains why a triggered trailing
        // stop did NOT exit. (This is what makes the post-sell cooldown
        // obsolete: the sell-then-rebuy churn path no longer exists.)
        if (hitTrailing && wouldBuyNow && !hitTakeProfit && !hitHardStop) {
          log.push(
            `${ticker}: Trailing-Stop erreicht (${price.toFixed(2)} ≤ ${trailingStopPrice.toFixed(2)} USD), ` +
              `aber These intakt (organic, Dip ${(dropFromHigh * 100).toFixed(1)}% unter Mehrwochenhoch, ` +
              `${(changePct * 100).toFixed(1)}% seit Einstieg) — HALTEN statt verkaufen, kein Churn.`,
          );
        }

        if (exitTriggered && !marketOpen) {
          // The exit condition fired, but a real account couldn't place the
          // order right now — log it so a glance at the run history explains
          // *why* a seemingly-overdue exit didn't happen yet. `price-refresh`
          // (which also respects market hours, see there) or the next
          // in-hours `market-scan` run will catch it the moment trading
          // resumes — same as a real standing order would.
          const exitDesc = hitTakeProfit
            ? `Take-Profit: +${(changePct * 100).toFixed(1)}% seit Einstieg`
            : hitHardStop
              ? `Hard-Stop: ${(changePct * 100).toFixed(1)}% seit Einstieg (Boden ${(HARD_STOP * 100).toFixed(0)}%)`
              : `Trailing-Stop: ${price.toFixed(2)} USD ≤ Stopkurs ${trailingStopPrice.toFixed(2)} USD (${Math.abs(STOP_LOSS * 100)}% unter Hoch ${newHigh.toFixed(2)} USD)`;
          log.push(
            `${ticker}: Exit-Schwelle erreicht (${exitDesc}), aber US-Börsen sind geschlossen — ` +
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
          // them too, `realized_pnl` looks rosier than the trade truly was.
          // Fetching the linked opening transaction (cheap: sells are
          // infrequent) makes this number mean what it says.
          const openingCosts = await fetchOpeningCosts(supabase, position.opening_transaction_id);
          // Convert the cost basis at the rate that applied when the position
          // was OPENED, not today's — otherwise a currency move between entry
          // and exit would silently get counted as "trading" P&L instead of FX P&L.
          const entryFxRate = openingCosts.usdChfRate ?? usdChfRate;
          const costBasisUsd = position.shares * position.entry_price;
          const costBasis = costBasisUsd * entryFxRate;
          const realizedPnl = proceeds - costBasis - openingCosts.fee - openingCosts.fxFee;
          // `exitReason` is computed once, above the market-hours branch — it
          // drives both this sell and the closed-market log line.

          // ── Race-condition guard ─────────────────────────────────────────
          // DELETE first (atomic DB operation), then INSERT the transaction.
          // If price-refresh fired at the same second and already claimed this
          // row, `deleted` is empty → skip to avoid a phantom double-sell.
          const { data: deleted } = await supabase
            .from('positions')
            .delete()
            .eq('id', position.id)
            .select('id');
          if (!deleted || deleted.length === 0) {
            log.push(`${ticker}: Position bereits von price-refresh verkauft — übersprungen.`);
            positions.splice(positions.indexOf(position), 1);
            continue;
          }

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
            // v14: record highest price reached — lets post-hoc SQL measure
            // how much the trailing stop improved vs. the old fixed stop.
            high_since_entry: newHigh,
            reason:
              exitReason === 'take-profit'
                ? `Take-Profit erreicht: +${(changePct * 100).toFixed(1)}% seit Einstieg.`
                : exitReason === 'hard-stop'
                  ? `Hard-Stop ausgelöst: ${(changePct * 100).toFixed(1)}% seit Einstieg ` +
                    `(unbedingter Kapitalboden bei ${(HARD_STOP * 100).toFixed(0)}%; Einstieg ${position.entry_price.toFixed(2)} USD, Kurs ${price.toFixed(2)} USD).`
                  : `Trailing-Stop ausgelöst: Kurs ${price.toFixed(2)} USD gefallen auf ≤ ${trailingStopPrice.toFixed(2)} USD ` +
                    `(${Math.abs(STOP_LOSS * 100)}% unter Hoch von ${newHigh.toFixed(2)} USD; Einstieg ${position.entry_price.toFixed(2)} USD; ` +
                    `These nicht mehr kaufwürdig).`,
          });
          positions.splice(positions.indexOf(position), 1);

          portfolio.cash += proceeds;
          portfolio.realized_pnl += realizedPnl;
          portfolio.total_fees += fee + fx;
          portfolio.trade_count += 1;
          log.push(`${ticker}: SELL ${position.shares} @ ${price} (PnL ${realizedPnl.toFixed(2)} CHF, Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX, Grund: ${exitReason})`);
          if (ntfyTopic) {
            const isTp = exitReason === 'take-profit';
            const isHardStop = exitReason === 'hard-stop';
            const ntfyTitle = isTp
              ? `✅ Take-Profit: ${ticker}`
              : isHardStop
                ? `🛑 Hard-Stop: ${ticker}`
                : `🔒 Trailing-Stop: ${ticker}`;
            const ntfyMsg =
              `${position.shares.toFixed(2)} Stk. @ ${price.toFixed(2)} USD\n` +
              `PnL: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)} CHF` +
              (isHardStop
                ? `\n${(changePct * 100).toFixed(1)}% seit Einstieg (Kapitalboden ${(HARD_STOP * 100).toFixed(0)}%)`
                : !isTp
                  ? `\nHöchstpreis war: ${newHigh.toFixed(2)} USD`
                  : '');
            const ntfyTags = isTp
              ? ['white_check_mark', 'money_with_wings']
              : isHardStop
                ? ['octagonal_sign', 'x']
                : ['lock', realizedPnl >= 0 ? 'white_check_mark' : 'x'];
            const ntfyPriority = isTp ? 4 : isHardStop ? 4 : 3;
            const eventType = isTp ? 'sell-tp' : isHardStop ? 'sell-hard-stop' : 'sell-trailing-stop';
            await sendNtfy(ntfyTopic, ntfyTitle, ntfyMsg, ntfyPriority as 1 | 2 | 3 | 4 | 5, ntfyTags);
            await logNotification(
              supabase, ntfyTitle, ntfyMsg, ntfyTopic,
              ntfyPriority, ntfyTags, eventType, ticker,
            );
          }
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
      //
      // `instrumentInfoByTicker.get(ticker)?.isEtf !== true`: a hard "never
      // buy an ETF" gate, grounded in Yahoo's own `instrumentType` rather than
      // the hand-curated `BROAD_MARKET_ETFS` list. That list only ever filters
      // DISCOVERY (so well-known index ETFs don't waste a watchlist slot —
      // see its comment for why their hype patterns are uninformative); it was
      // never a buy-time safety net, and a leveraged/thematic ETF that isn't
      // on it (TQQQ, SOXL, ARKQ, ...) could in principle clear the "organic"
      // heuristic and get bought. This closes that gap with real classification
      // data instead of an inevitably-incomplete list. `!== true` (rather than
      // `=== false`) deliberately treats "Yahoo didn't say" (`null`) as "go
      // ahead" — refusing a perfectly good stock buy over momentarily-missing
      // metadata would be a worse failure mode than the near-impossible case
      // of an actual ETF slipping through with no `instrumentType` at all.
      if (
        marketOpen &&
        !buyGateActive &&
        !position &&
        verdict === 'organic' &&
        instrumentInfoByTicker.get(ticker)?.isEtf !== true &&
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
        // (`recentHigh`/`dropFromHigh` are now hoisted above, alongside
        // `position` — see the comment there for why both moved up.)
        if (isFullDip || isNearMiss) {
          // No post-sell cooldown here anymore: the intelligent sell/hold gate
          // above (see the two-level exit design at HARD_STOP) HOLDS a position
          // whenever the buy-check would re-open it, so the sell-then-rebuy
          // churn path the cooldown used to guard simply can't occur. The only
          // sell that can be followed by a fresh entry is a -8% HARD_STOP, and
          // that re-entry — 6h+ later, at a lower price, with a re-confirmed
          // organic thesis — is a deliberate new trade, not churn.

          // ── Measure 1 + 3: near-miss only buys with confirmed trend ─────
          // Full dip → always buy (full size).
          // Near-miss → only buy if 2+ consecutive prior organic scans
          // confirm this is a real trend, not a one-scan noise spike.
          // In that case: full position immediately — no half-size trades
          // (a half position carries a disproportionately high fee ratio
          // due to Swissquote's near-flat brokerage and can't be topped up
          // once the position is open, making it worse on both dimensions).
          let consecutiveOrganic = 0;
          let entryNote = '';
          if (isNearMiss) {
            consecutiveOrganic = await getConsecutiveOrganicCount(supabase, ticker);
            if (consecutiveOrganic < CONSECUTIVE_ORGANIC_THRESHOLD) {
              // Not enough confirmation yet — skip and wait for a full dip
              // or more consecutive organic scans.
              log.push(`${ticker}: Near-Miss (Dip ${(dropFromHigh * 100).toFixed(1)}%) übersprungen — erst ${consecutiveOrganic}/${CONSECUTIVE_ORGANIC_THRESHOLD} aufeinanderfolgende organische Scans.`);
              continue;
            }
            entryNote = ` Near-Miss-Einstieg (Dip ${(dropFromHigh * 100).toFixed(1)}%, Schwelle −${(Math.abs(DIP_THRESH) * 100).toFixed(0)}%), bestätigt durch ${consecutiveOrganic}× in Folge organisch.`;
          }

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
          const budget = totalValue * POSITION_SIZE; // CHF
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
              // v11/v12: macro context at buy time — so "did we buy in fear/greed
              // conditions, and how did it turn out?" is directly queryable from
              // the snapshot JSON without needing a timestamp-based join.
              fear_greed_score: fearGreedScore,
              yf_trending: yfTrendingSet.has(ticker),
              finviz_news: finVizNewsSet.has(ticker),
              // Measure 1 + 3: entry confidence metadata
              near_miss_entry: isNearMiss,
              consecutive_organic_prior: consecutiveOrganic,
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
                reason: `Swing-Einstieg: ${(dropFromHigh * 100).toFixed(1)}% unter dem Mehrwochenhoch (${dailyHistory.length} Handelstage), Hype organisch (Score ${hypeScore.toFixed(0)}, z=${zScore.toFixed(1)}) & von Stimmung/Kurs bestätigt.${entryNote}`,
              })
              .select()
              .single();

            const { data: inserted } = await supabase
              .from('positions')
              .insert({
                ticker,
                shares,
                entry_price: price,
                opening_transaction_id: txRow?.id ?? null,
                high_since_entry: price, // v14: trailing stop tracking starts at entry
              })
              .select()
              .single();
            if (inserted) positions.push(inserted as PositionRow);

            portfolio.cash -= grossAmount + fee + fx;
            portfolio.total_fees += fee + fx;
            portfolio.trade_count += 1;
            log.push(`${ticker}: BUY ${shares.toFixed(4)} @ ${price} (Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX)`);
            if (ntfyTopic) {
              const buyTitle = `🟢 Kauf: ${ticker}`;
              const buyMsg =
                `${shares.toFixed(2)} Stk. @ ${price.toFixed(2)} USD\n` +
                `Investiert: ~${grossAmount.toFixed(0)} CHF (inkl. Gebühren)\n` +
                `Take-Profit bei: ${(price * (1 + TAKE_PROFIT)).toFixed(2)} USD (+${(TAKE_PROFIT * 100).toFixed(0)}%)\n` +
                `Stop bei: ${(price * (1 + STOP_LOSS)).toFixed(2)} USD (${(STOP_LOSS * 100).toFixed(0)}%)`;
              await sendNtfy(ntfyTopic, buyTitle, buyMsg, 4, ['green_circle', 'chart_with_upwards_trend']);
              await logNotification(
                supabase, buyTitle, buyMsg, ntfyTopic, 4,
                ['green_circle', 'chart_with_upwards_trend'],
                'buy',
                ticker,
              );
            }
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
      // v10: macro gate score stored on every snapshot — dashboard derives the
      // "latest" F&G reading from balance_history (written every run, trades or
      // not), so the stat card stays current between trade runs too.
      fear_greed_score: fearGreedScore,
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
