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
//   net win  ≈ 0.20 - 0.044 ≈ +15.6%   net loss ≈ -0.06 - 0.044 ≈ -10.4%
//   → breakeven hit rate ≈ 40%, a comfortably realistic bar for a heuristic
//     with a genuine, if modest, edge.
const TAKE_PROFIT = 0.2;
const STOP_LOSS = -0.06;

// Currency-conversion spread Swissquote charges on USD-denominated trades from
// a CHF account — kept in sync with the same constant in `market-scan`.
const FX_FEE_RATE = 0.0095;

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

    const latestPrices = new Map<string, number>();

    for (const position of [...positions]) {
      const price = await fetchLatestPrice(position.ticker);
      if (price === null) {
        log.push(`${position.ticker}: kein aktueller Kurs verfügbar — Position bleibt unverändert.`);
        continue;
      }
      latestPrices.set(position.ticker, price);

      const change = (price - position.entry_price) / position.entry_price;
      if (change >= TAKE_PROFIT || change <= STOP_LOSS) {
        const grossAmount = position.shares * price;
        const fee = swissquoteFee(grossAmount);
        const fx = fxFee(grossAmount);
        const proceeds = grossAmount - fee - fx;
        const costBasis = position.shares * position.entry_price;
        // See `market-scan`'s sell branch for the full explanation: costBasis
        // alone omits the BUY's brokerage fee + FX margin (paid out of cash
        // separately), which made `realized_pnl` look more profitable than
        // the trade truly was. Subtracting the linked opening transaction's
        // costs makes the number honest.
        const openingCosts = await fetchOpeningCosts(supabase, position.opening_transaction_id);
        const realizedPnl = proceeds - costBasis - openingCosts.fee - openingCosts.fxFee;
        const interim = change >= TAKE_PROFIT ? 'interim-take-profit' : 'interim-stop-loss';

        await supabase.from('transactions').insert({
          ticker: position.ticker,
          action: 'sell',
          shares: position.shares,
          price,
          fee,
          fx_fee: fx,
          currency: 'USD',
          gross_amount: grossAmount,
          realized_pnl: realizedPnl,
          opening_transaction_id: position.opening_transaction_id,
          exit_reason: interim,
          reason:
            change >= TAKE_PROFIT
              ? `[Zwischen-Check] Take-Profit erreicht: +${(change * 100).toFixed(1)}% seit Einstieg.`
              : `[Zwischen-Check] Stop-Loss ausgelöst: ${(change * 100).toFixed(1)}% seit Einstieg.`,
        });
        await supabase.from('positions').delete().eq('id', position.id);
        positions.splice(positions.indexOf(position), 1);
        latestPrices.delete(position.ticker);

        portfolio.cash += proceeds;
        portfolio.realized_pnl += realizedPnl;
        portfolio.total_fees += fee + fx;
        portfolio.trade_count += 1;
        log.push(
          `${position.ticker}: SELL ${position.shares} @ ${price} zwischen den vollen Scans ` +
            `(PnL ${realizedPnl.toFixed(2)} CHF, Gebühren ${(fee + fx).toFixed(2)} CHF inkl. FX, Grund: ${change >= TAKE_PROFIT ? 'Take-Profit' : 'Stop-Loss'}).`,
        );
      } else {
        log.push(`${position.ticker}: ${(change * 100).toFixed(1)}% seit Einstieg, kein Exit-Trigger.`);
      }
    }

    await supabase
      .from('portfolio')
      .update({ ...portfolio, updated_at: new Date().toISOString() })
      .eq('id', true);

    const positionsValue = positions.reduce(
      (sum, p) => sum + p.shares * (latestPrices.get(p.ticker) ?? p.entry_price),
      0,
    );
    const spyPrice = await fetchBenchmarkPrice();
    await supabase.from('balance_history').insert({
      cash: portfolio.cash,
      positions_value: positionsValue,
      total_value: portfolio.cash + positionsValue,
      spy_price: spyPrice,
    });
    log.push(
      `Portfolio aktualisiert: Cash ${portfolio.cash.toFixed(2)} CHF, ` +
        `Positionswert ${positionsValue.toFixed(2)} CHF, Gesamt ${(portfolio.cash + positionsValue).toFixed(2)} CHF.`,
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
