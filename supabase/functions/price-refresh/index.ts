// Supabase Edge Function: price-refresh
//
// Companion to `market-scan`. Where `market-scan` runs every 6 hours and does
// the EXPENSIVE work (discovering trends across several sources, classifying
// hype, opening new positions), this function is intentionally tiny and cheap
// — it is meant to run much more often (e.g. every 15-30 minutes via its own
// pg_cron job, see supabase/trading_schema.sql) and do only two things:
//
//   1. Re-price every OPEN position via Yahoo Finance and check whether
//      take-profit / stop-loss has been hit in the meantime — so we don't
//      ride a position past its exit for up to 6 hours just because the next
//      full scan hasn't run yet.
//   2. Recompute the portfolio's current total value (cash + mark-to-market
//      value of open positions) and write a fresh `balance_history` snapshot,
//      so the dashboard chart and stat cards reflect what the portfolio is
//      worth RIGHT NOW, not just at the last full scan.
//
// It deliberately does NOT discover new tickers, fetch sentiment, or open new
// positions — that stays the job of `market-scan`, both to limit how often we
// hit the external APIs and to avoid over-trading on noise between scans.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

// Kept in sync with `market-scan` — see the detailed strategy-constants
// comment there for the full reasoning. Short version: Swissquote's
// round-trip cost (brokerage + FX margin, EACH WAY) hits every exit, win or
// lose, so single-digit-percent thresholds (the original ±2.5%/±4% pump-&-dip
// shape, and even the later ±8%/±3.5% iteration) make the strategy
// structurally unprofitable — e.g. ±8%/±3.5% nets roughly +1.7% on wins vs.
// -9.8% on losses, requiring an ~85% hit rate just to break even. The
// strategy is now SWING-shaped instead (days-to-weeks holds, larger targets)
// AND sized in fewer/larger positions (POSITION_SIZE 0.12 → 0.24, MAX_
// POSITIONS 5 → 3 — see `market-scan` for why), both of which shrink that
// near-fixed brokerage tax to a small fraction of the targeted move:
//   round-trip tax ≈ 4.4%  (≈30 CHF commission + ~0.95% FX margin, EACH WAY,
//                           on a ~24%-of-portfolio / ~2'400 CHF position)
//   net win  ≈ 0.20 - 0.044 ≈ +15.6%   net loss ≈ -0.08 - 0.044 ≈ -12.4%
//   → breakeven hit rate ≈ 44%, a comfortably realistic bar for a heuristic
//     with a genuine, if modest, edge.
//
// ── Sharing the intelligent sell/hold gate with market-scan (v17) ──────────
// The trailing stop is SUPPRESSED while a position is still "buy-eligible"
// (organic + in the dip range) — the engine HOLDS instead of churning out a
// position it would immediately re-open (see the two-level exit design in
// market-scan). That suppression needs the `verdict` classification and the
// multi-week high, which THIS function never computes (it only re-prices).
// market-scan therefore PERSISTS both onto the position row every 6h
// (`recent_high` / `last_verdict`, see trading_schema_v17_position_meta.sql),
// so price-refresh can apply the IDENTICAL wouldBuyNow suppression here too —
// restoring frequent (~15-30min) profit-locking without reintroducing churn.
// The unconditional take-profit (+20%) and -8% hard stop always fire; the
// trailing stop fires only when the persisted meta proves we would NOT re-buy.
// If that meta is missing (migration pending / legacy row), the trailing stop
// stays dormant here and falls back to market-scan's 6-hourly run.
let TAKE_PROFIT = 0.2;
let STOP_LOSS = -0.06; // trailing-stop distance below the since-entry peak
let HARD_STOP = -0.08; // unconditional capital floor, % loss from entry

// Dip thresholds — kept in sync with market-scan. Used to mirror its
// `wouldBuyNow` trailing-stop suppression: a position whose price is at least
// (DIP_THRESH + NEAR_DIP_BUFFER) below its stored multi-week high AND still
// classified 'organic' is one the engine would re-open, so price-refresh HOLDS
// it instead of churning it out on a trailing stop (see the v17 logic below).
let DIP_THRESH = -0.04;
let NEAR_DIP_BUFFER = 0.01;

// Currency-conversion spread Swissquote charges on USD-denominated trades from
// a CHF account — kept in sync with the same constant in `market-scan`.
const FX_FEE_RATE = 0.0095;

// Real USD/CHF exchange-rate model — kept in sync with `market-scan` (see the
// detailed comment there for the full reasoning). Short version: "1 USD ≈
// 1 CHF" was a meaningfully wrong simplification once you actually hold
// USD-denominated stocks from a CHF account; only the conversion-margin
// SPREAD (FX_FEE_RATE) was modelled before, not the underlying rate's own
// movement. `fetchUsdChfRate()` fetches the live spot rate from the same
// Yahoo Finance endpoint already used for stock prices (`USDCHF=X`); this
// fallback is purely a safety net for when that fetch fails.
const FALLBACK_USD_CHF_RATE = 0.80;

interface PositionRow {
  id: number;
  ticker: string;
  shares: number;
  entry_price: number;
  opening_transaction_id: number | null;
  /** Highest price seen since open — trailing stop fires at high_since_entry × (1 + STOP_LOSS). */
  high_since_entry: number;
  /** v17: multi-week high from the last market-scan — reference for the dip / wouldBuyNow check. */
  recent_high?: number | null;
  /** v17: most recent verdict from market-scan — used to mirror the trailing-stop suppression. */
  last_verdict?: string | null;
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

function fxFee(amount: number): number {
  return amount * FX_FEE_RATE;
}

/**
 * Mirrors the identically-named/-implemented helper in `market-scan` (see
 * there for the full reasoning) — kept duplicated rather than shared per this
 * project's "no shared module between the two tiny Edge Functions" convention.
 *
 * Gates this function's entire run (see the check at the top of `Deno.serve`):
 * a real Swissquote account can't fill US-equity orders while NYSE/NASDAQ are
 * closed, and prices don't move between closes either — so re-pricing
 * positions and checking exit triggers outside the regular session would be
 * pure overhead that can't lead to a real action.
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

async function fetchBenchmarkPrice(): Promise<number | null> {
  return fetchLatestPrice('SPY');
}

/**
 * Looks up the brokerage fee + FX margin paid when a position was OPENED —
 * needed so `realized_pnl` reflects the true round-trip cost, not just the
 * exit-side cost (see the comment at the realized_pnl computation below).
 * Mirrors the identically-named helper in `market-scan`; kept duplicated
 * rather than shared since these two tiny Edge Functions intentionally have
 * no shared module (simpler deploys, no risk of one breaking the other).
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
    usdChfRate: data.usd_chf_rate === null || data.usd_chf_rate === undefined ? null : Number(data.usd_chf_rate),
  };
}

/**
 * Live USD/CHF spot rate — mirrors the identically-named/-implemented helper
 * in `market-scan` (see there for the full reasoning); kept duplicated per
 * this project's "no shared module between the two tiny Edge Functions"
 * convention. Reuses the same Yahoo Finance chart endpoint as
 * `fetchLatestPrice` below, just with the `USDCHF=X` FX-pair symbol.
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

// Same Yahoo Finance chart endpoint `market-scan` uses for daily history — but
// here we only need the single most recent close, so a short 5-day range is
// enough and keeps the request (and parsing) minimal.
async function fetchLatestPrice(ticker: string): Promise<number | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?range=5d&interval=1d`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`price-refresh: Yahoo Finance fetch failed for ${ticker}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (data?.chart?.error || !result) return null;
    const closes: unknown[] = result?.indicators?.quote?.[0]?.close ?? [];
    for (let i = closes.length - 1; i >= 0; i -= 1) {
      const value = closes[i];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  } catch (err) {
    console.warn(`price-refresh: Yahoo Finance errored for ${ticker}: ${err}`);
    return null;
  }
}

// Mirrors the identically-named helper in `market-scan` — kept duplicated per
// this project's "no shared module between Edge Functions" convention.
async function sendNtfy(
  topic: string,
  title: string,
  message: string,
  priority: 1 | 2 | 3 | 4 | 5 = 3,
  tags: string[] = [],
): Promise<void> {
  try {
    // HTTP headers are ByteStrings (Latin-1, ≤255) — emoji in `X-Title` make
    // Deno's fetch throw before sending, which the catch then swallows (THE
    // reason phone pushes never arrived while the Notification Center still
    // logged them). Strip non-Latin-1 chars from the title; emoji still reach
    // the phone via `X-Tags`. The UTF-8 body is unaffected. See the fuller
    // comment on the identical helper in market-scan.
    const headerSafeTitle = title.replace(/[^\x00-\xFF]/gu, '').replace(/\s+/g, ' ').trim();
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'X-Title': headerSafeTitle,
        'X-Priority': String(priority),
        ...(tags.length ? { 'X-Tags': tags.join(',') } : {}),
      },
      body: message,
    });
    if (!res.ok) {
      console.warn(`ntfy push not delivered (HTTP ${res.status}): ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.warn(`ntfy notification failed (non-critical): ${err}`);
  }
}

// Persists the sent notification to `push_notifications` for the dashboard
// Notification Center. Non-critical — called after sendNtfy(), failure never
// interrupts the trade run. Mirrors market-scan's logNotification.
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

/**
 * v18: load the strategy knobs this function uses from the singleton
 * `strategy_config` table (single source of truth shared with market-scan and
 * the dashboard — see trading_schema_v18_strategy_config.sql). Hard-coded
 * values above stay as fallbacks if the migration is pending or the read fails.
 */
// deno-lint-ignore no-explicit-any
async function applyStrategyConfig(supabase: any, log: string[]): Promise<void> {
  try {
    const { data, error } = await supabase.from('strategy_config').select('*').eq('id', true).maybeSingle();
    if (error || !data) {
      log.push('Strategie-Konfiguration (v18) nicht verfügbar — Lauf nutzt die eingebauten Standardwerte.');
      return;
    }
    const num = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
    TAKE_PROFIT = num(data.take_profit, TAKE_PROFIT);
    STOP_LOSS = num(data.stop_loss, STOP_LOSS);
    HARD_STOP = num(data.hard_stop, HARD_STOP);
    DIP_THRESH = num(data.dip_thresh, DIP_THRESH);
    NEAR_DIP_BUFFER = num(data.near_dip_buffer, NEAR_DIP_BUFFER);
  } catch (err) {
    log.push(`Strategie-Konfiguration konnte nicht geladen werden (${err}) — Standardwerte aktiv.`);
  }
}

Deno.serve(async () => {
  // Skip the entire run while US exchanges are closed: no exit could be
  // executed even if one triggered, prices haven't moved since the last
  // close (so re-fetching them is wasted Yahoo Finance calls), and writing a
  // `balance_history` snapshot would just repeat the same total_value as a
  // redundant flat-line point — `market-scan` already provides snapshot
  // continuity every 6h regardless of market hours (see the `marketOpen`
  // comment there for why ITS snapshot stays ungated). Cheap to check first,
  // before even creating the Supabase client.
  if (!isUsMarketOpen()) {
    return new Response(
      JSON.stringify(
        {
          ok: true,
          log: [
            'US-Börsen (NYSE/NASDAQ) sind aktuell geschlossen (ausserhalb 09:30–16:00 America/New_York, Mo–Fr) — ' +
              'Lauf übersprungen: kein Repricing, kein Exit-Check, kein Snapshot nötig (ein echtes Konto könnte ' +
              'ohnehin nicht handeln, und die Kurse bewegen sich nicht zwischen den Schlusskursen).',
          ],
        },
        null,
        2,
      ),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const ntfyTopic = Deno.env.get('NTFY_TOPIC') ?? '';

  const log: string[] = [];
  try {
    // v18: DB-backed strategy knobs (falls back to the defaults above).
    await applyStrategyConfig(supabase, log);

    const { data: portfolioRow, error: portfolioError } = await supabase
      .from('portfolio')
      .select('*')
      .eq('id', true)
      .single();
    if (portfolioError) throw portfolioError;
    const portfolio = portfolioRow as PortfolioRow;

    // Snapshot the additive fields BEFORE mutation — the final write applies
    // (final − initial) atomically via apply_portfolio_delta so a concurrent
    // market-scan run can't clobber this run's sale proceeds (and vice versa).
    // See trading_schema_v16_atomic_portfolio.sql. price-refresh never touches
    // blocked_count/blocked_capital, so it passes null for those (leave as-is).
    const initialCash = portfolio.cash;
    const initialRealizedPnl = portfolio.realized_pnl;
    const initialTotalFees = portfolio.total_fees;
    const initialTradeCount = portfolio.trade_count;

    const { data: openPositions, error: positionsError } = await supabase
      .from('positions')
      .select('*');
    if (positionsError) throw positionsError;
    const positions = (openPositions ?? []) as PositionRow[];

    // Fetched ONCE per run and shared across every conversion below — mirrors
    // `market-scan`'s approach (see the constant comment there for the full
    // reasoning behind modelling a real exchange rate at all).
    const usdChfRate = await fetchUsdChfRate();

    const latestPrices = new Map<string, number>();

    for (const position of [...positions]) {
      const price = await fetchLatestPrice(position.ticker);
      if (price === null) {
        log.push(`${position.ticker}: kein aktueller Kurs verfügbar — Position bleibt unverändert.`);
        continue;
      }
      latestPrices.set(position.ticker, price);

      // Keep the running high current — the trailing stop (below) fires at
      // high_since_entry × (1 + STOP_LOSS).
      const newHigh = Math.max(position.high_since_entry, price);
      if (newHigh > position.high_since_entry) {
        await supabase.from('positions').update({ high_since_entry: newHigh }).eq('id', position.id);
        position.high_since_entry = newHigh;
      }

      // Keep the multi-week reference high current INTRADAY too. market-scan
      // refreshes `recent_high` only every ~6h — if the stock makes a fresh
      // high between scans and then slides 6%, a stale (lower) reference makes
      // the dip look shallower than it is, flips `wouldBuyNow` to false, and
      // this function would SELL where market-scan (whose daily-close data
      // includes today's running close) would HOLD — reopening the exact churn
      // window the suppression exists to close. A new price above the stored
      // multi-week high IS the new multi-week high, so ratcheting it up here
      // keeps both functions judging the dip against the same reference.
      if (position.recent_high != null && price > position.recent_high) {
        await supabase.from('positions').update({ recent_high: price }).eq('id', position.id);
        position.recent_high = price;
      }

      const changePct = (price - position.entry_price) / position.entry_price;
      const trailingStopPrice = newHigh * (1 + STOP_LOSS); // peak × 0.94

      // ── Exit gate — mirrors market-scan's three-trigger design ───────────
      const hitTakeProfit = changePct >= TAKE_PROFIT; // +20% from entry — unconditional
      const hitHardStop = changePct <= HARD_STOP; // -8% from entry — unconditional capital floor
      const hitTrailing = price <= trailingStopPrice; // -6% below since-entry peak

      // v17: apply the SAME verdict-aware suppression market-scan uses, from the
      // data it persists on the position. `wouldBuyNow` ⇒ the engine would
      // re-open this dip → HOLD instead of churning it out. We can only judge
      // that with both inputs present; if the v17 columns aren't there yet
      // (migration pending / legacy row), `hasMeta` is false and the trailing
      // stop simply doesn't fire here — falling back to the pre-v17 TP+hard-stop
      // behaviour, so price-refresh never sells something market-scan would hold.
      const hasMeta =
        position.recent_high != null && position.recent_high > 0 && position.last_verdict != null;
      let wouldBuyNow = false;
      if (hasMeta) {
        const dropFromHigh = (price - position.recent_high!) / position.recent_high!;
        const isDipOrNear = dropFromHigh <= DIP_THRESH + NEAR_DIP_BUFFER; // full dip or near-miss
        wouldBuyNow = position.last_verdict === 'organic' && isDipOrNear;
      }

      const exitTriggered =
        hitTakeProfit || hitHardStop || (hasMeta && hitTrailing && !wouldBuyNow);

      if (exitTriggered) {
        // `grossAmount` must be the CHF-converted figure (what actually lands
        // in `cash` once Swissquote converts the USD sale proceeds) — see
        // `market-scan`'s sell branch for the full reasoning behind the FX model.
        const grossAmountUsd = position.shares * price;
        const grossAmount = grossAmountUsd * usdChfRate;
        const fee = swissquoteFee(grossAmount);
        const fx = fxFee(grossAmount);
        const proceeds = grossAmount - fee - fx;
        const openingCosts = await fetchOpeningCosts(supabase, position.opening_transaction_id);
        const entryFxRate = openingCosts.usdChfRate ?? usdChfRate;
        const costBasisUsd = position.shares * position.entry_price;
        const costBasis = costBasisUsd * entryFxRate;
        const realizedPnl = proceeds - costBasis - openingCosts.fee - openingCosts.fxFee;
        const exitReason: 'interim-take-profit' | 'interim-hard-stop' | 'interim-trailing-stop' =
          hitTakeProfit ? 'interim-take-profit' : hitHardStop ? 'interim-hard-stop' : 'interim-trailing-stop';

        // ── Race-condition guard ───────────────────────────────────────────
        // DELETE first (atomic), then INSERT the transaction. If market-scan
        // fired at the same second and already deleted this row, `deleted` is
        // empty and we skip — avoiding a phantom double-sell in the log.
        const { data: deleted } = await supabase
          .from('positions')
          .delete()
          .eq('id', position.id)
          .select('id');
        if (!deleted || deleted.length === 0) {
          log.push(`${position.ticker}: Position bereits von market-scan verkauft — übersprungen.`);
          positions.splice(positions.indexOf(position), 1);
          latestPrices.delete(position.ticker);
          continue;
        }

        await supabase.from('transactions').insert({
          ticker: position.ticker,
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
          // v14: record highest price reached for post-hoc trailing-stop analysis
          high_since_entry: newHigh,
          reason:
            hitTakeProfit
              ? `[Zwischen-Check] Take-Profit erreicht: +${(changePct * 100).toFixed(1)}% seit Einstieg.`
              : hitHardStop
                ? `[Zwischen-Check] Hard-Stop ausgelöst: ${(changePct * 100).toFixed(1)}% seit Einstieg ` +
                  `(unbedingter Kapitalboden bei ${(HARD_STOP * 100).toFixed(0)}%; Einstieg ${position.entry_price.toFixed(2)} USD, Kurs ${price.toFixed(2)} USD).`
                : `[Zwischen-Check] Trailing-Stop ausgelöst: Kurs ${price.toFixed(2)} USD ≤ Stopkurs ${trailingStopPrice.toFixed(2)} USD ` +
                  `(${Math.abs(STOP_LOSS * 100)}% unter Hoch ${newHigh.toFixed(2)} USD; These nicht mehr kaufwürdig: Verdict ${position.last_verdict}).`,
        });
        positions.splice(positions.indexOf(position), 1);
        latestPrices.delete(position.ticker);

        portfolio.cash += proceeds;
        portfolio.realized_pnl += realizedPnl;
        portfolio.total_fees += fee + fx;
        portfolio.trade_count += 1;
        log.push(
          `${position.ticker}: SELL ${position.shares} @ ${price} zwischen den vollen Scans ` +
            `(PnL ${realizedPnl.toFixed(2)} CHF, Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX, Grund: ${exitReason}).`,
        );
        if (ntfyTopic) {
          const isTp = exitReason === 'interim-take-profit';
          const isHardStop = exitReason === 'interim-hard-stop';
          const ntfyTitle = isTp
            ? `✅ Take-Profit: ${position.ticker}`
            : isHardStop
              ? `🛑 Hard-Stop: ${position.ticker}`
              : `🔒 Trailing-Stop: ${position.ticker}`;
          const ntfyMsg =
            `${position.shares.toFixed(2)} Stk. @ ${price.toFixed(2)} USD [Zwischen-Check]\n` +
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
          const eventType = isTp
            ? 'sell-interim-tp'
            : isHardStop
              ? 'sell-interim-hard-stop'
              : 'sell-interim-trailing-stop';
          await sendNtfy(ntfyTopic, ntfyTitle, ntfyMsg, isTp || isHardStop ? 4 : 3, ntfyTags);
          await logNotification(
            supabase, ntfyTitle, ntfyMsg, ntfyTopic, isTp || isHardStop ? 4 : 3, ntfyTags,
            eventType, position.ticker,
          );
        }
      } else {
        // No exit fired. Show where the trailing stop sits and whether it's
        // currently SUPPRESSED (position still buy-eligible per the v17 meta →
        // we'd hold, not churn) so the run history explains a non-exit.
        const trailingInfo = newHigh > position.entry_price
          ? `, Trailing-Stop bei ${trailingStopPrice.toFixed(2)} USD (Hoch: ${newHigh.toFixed(2)})`
          : '';
        const holdInfo = hasMeta && hitTrailing && wouldBuyNow
          ? ' — Trailing erreicht, aber These intakt (organic + Dip), HALTEN'
          : '';
        log.push(`${position.ticker}: ${(changePct * 100).toFixed(1)}% seit Einstieg${trailingInfo}${holdInfo}, kein Exit-Trigger.`);
      }
    }

    // Atomic delta apply (v16) instead of a full-row overwrite — see
    // trading_schema_v16_atomic_portfolio.sql. Passing null for the blocked_*
    // params leaves those columns untouched (market-scan owns them).
    const { error: portfolioRpcError } = await supabase.rpc('apply_portfolio_delta', {
      d_cash: portfolio.cash - initialCash,
      d_realized_pnl: portfolio.realized_pnl - initialRealizedPnl,
      d_total_fees: portfolio.total_fees - initialTotalFees,
      d_trade_count: portfolio.trade_count - initialTradeCount,
      set_blocked_count: null,
      set_blocked_capital: null,
    });
    if (portfolioRpcError) {
      console.warn(`apply_portfolio_delta RPC failed, falling back to full overwrite: ${portfolioRpcError.message}`);
      log.push('⚠️ Portfolio-RPC (v16) nicht verfügbar — Fallback auf Vollüberschreibung (Race möglich). Migration trading_schema_v16_atomic_portfolio.sql ausführen!');
      await supabase
        .from('portfolio')
        .update({ ...portfolio, updated_at: new Date().toISOString() })
        .eq('id', true);
    }

    // Snapshot from FRESH DB state, not this run's in-memory copy — if
    // market-scan traded while this run was in flight, memory is stale and a
    // memory-based snapshot records an inconsistent point (the same class of
    // glitch the v16 atomic apply fixed for the portfolio row itself). Two
    // tiny reads make the snapshot match reality; mirrors market-scan.
    const { data: freshPortfolioRow } = await supabase
      .from('portfolio')
      .select('cash')
      .eq('id', true)
      .maybeSingle();
    const snapshotCash = freshPortfolioRow ? Number(freshPortfolioRow.cash) : portfolio.cash;
    const { data: freshPositionRows } = await supabase
      .from('positions')
      .select('ticker, shares, entry_price');
    const snapshotPositions = (freshPositionRows ?? positions) as Pick<
      PositionRow,
      'ticker' | 'shares' | 'entry_price'
    >[];

    // USD-denominated mark-to-market value, converted to CHF via the same
    // live rate used for every other conversion this run (see `market-scan`'s
    // snapshot for the identical reasoning).
    const positionsValueUsd = snapshotPositions.reduce(
      (sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price),
      0,
    );
    const positionsValue = positionsValueUsd * usdChfRate;
    const spyPrice = await fetchBenchmarkPrice();
    await supabase.from('balance_history').insert({
      cash: snapshotCash,
      positions_value: positionsValue,
      total_value: snapshotCash + positionsValue,
      spy_price: spyPrice,
      usd_chf_rate: usdChfRate,
    });
    log.push(
      `Portfolio aktualisiert: Cash ${snapshotCash.toFixed(2)} CHF, ` +
        `Positionswert ${positionsValue.toFixed(2)} CHF, Gesamt ${(snapshotCash + positionsValue).toFixed(2)} CHF.`,
    );

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
