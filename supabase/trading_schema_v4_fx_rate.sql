-- Migration v4 — run this in the Supabase SQL editor AFTER
-- trading_schema_v3_signal_performance_views.sql has been applied. Purely
-- additive (ALTER TABLE ... ADD COLUMN IF NOT EXISTS) and safe to re-run.
--
-- WHY: until now the simulation treated "1 USD ≈ 1 CHF" for every trade —
-- only Swissquote's conversion-margin SPREAD (`fx_fee`, ~0.95% per
-- transaction) was modelled, not the underlying exchange rate itself. That
-- was a meaningfully wrong simplification: USD/CHF has moved by double-digit
-- percentages over periods as short as a year, and a CHF-based investor
-- holding USD-denominated stocks is exposed to BOTH the stock's price move
-- AND the currency's move between entry and exit. The Edge Functions
-- (`market-scan`, `price-refresh`) now fetch the live USD/CHF spot rate once
-- per run (Yahoo Finance `USDCHF=X`) and record it on every transaction and
-- balance snapshot — both for transparency in the UI, and so a SELL's
-- `realized_pnl` can convert its matching BUY's cost basis at the rate that
-- applied when the position was OPENED rather than today's rate (otherwise a
-- currency move between entry and exit would silently get misattributed as
-- "trading" P&L instead of FX P&L).
--
-- New column on BOTH tables:
--   `usd_chf_rate` — "how many CHF does 1 USD buy", at the moment this row
--   was written. On `transactions`, lets you derive the USD-denominated trade
--   value from the stored CHF `gross_amount` (`gross_amount / usd_chf_rate`)
--   and shows exactly which rate a given trade's CHF conversion used. On
--   `balance_history`, lets you see what rate converted that snapshot's
--   USD-denominated `positions_value` mark-to-market into CHF.

alter table public.transactions
  add column if not exists usd_chf_rate numeric;

alter table public.balance_history
  add column if not exists usd_chf_rate numeric;

-- Nothing to backfill: existing rows simply have usd_chf_rate = null, which
-- accurately reflects "this row predates the FX-rate model" rather than
-- fabricating a historical rate we don't actually have on file. The Edge
-- Functions already treat `null` here as "fall back to today's live rate"
-- for legacy positions (see `fetchOpeningCosts` in both functions).
