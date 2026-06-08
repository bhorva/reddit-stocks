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

const TAKE_PROFIT = 0.04;
const STOP_LOSS = -0.035;

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
        const proceeds = grossAmount - fee;
        const costBasis = position.shares * position.entry_price;
        const realizedPnl = proceeds - costBasis;

        await supabase.from('transactions').insert({
          ticker: position.ticker,
          action: 'sell',
          shares: position.shares,
          price,
          fee,
          gross_amount: grossAmount,
          realized_pnl: realizedPnl,
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
        portfolio.total_fees += fee;
        portfolio.trade_count += 1;
        log.push(
          `${position.ticker}: SELL ${position.shares} @ ${price} zwischen den vollen Scans ` +
            `(PnL ${realizedPnl.toFixed(2)} CHF, Grund: ${change >= TAKE_PROFIT ? 'Take-Profit' : 'Stop-Loss'}).`,
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
    await supabase.from('balance_history').insert({
      cash: portfolio.cash,
      positions_value: positionsValue,
      total_value: portfolio.cash + positionsValue,
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
