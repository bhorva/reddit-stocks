-- Migration v2 — run this in the Supabase SQL editor AFTER trading_schema.sql
-- has already been applied. It is purely additive (ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS) and safe to re-run.
--
-- It supports several process improvements:
--
--  1. FX cost realism: trades on US tickers from a CHF-denominated account
--     incur a currency-conversion spread at Swissquote (in addition to the
--     brokerage commission), which the simulation previously ignored. New
--     `currency` / `fx_fee` columns make this an explicit, queryable cost.
--
--  2. Structured trade learning: `signal_snapshot` captures the full feature
--     set the engine saw at the moment of a BUY (hype score, mention count,
--     baseline, sentiment ratio, dip %, price trend) as JSON, and
--     `opening_transaction_id` links a SELL back to the BUY that opened the
--     position — so a future review can run a single SQL query like
--     "of all organic-verdict buys, what % closed at take-profit vs.
--     stop-loss, and what was the average holding period?" instead of
--     manually reconstructing it from prose `reason` strings.
--
--  3. Benchmark comparison: `spy_price` on `balance_history` records the
--     S&P-500 ETF (SPY) price alongside every snapshot, so the dashboard can
--     show "what would the same starting capital be worth if it had simply
--     been parked in an index fund instead" — the only way to tell whether
--     the strategy is actually adding value over a naive baseline.

alter table public.transactions
  add column if not exists currency text not null default 'USD',
  add column if not exists fx_fee numeric not null default 0,
  add column if not exists signal_snapshot jsonb,
  add column if not exists opening_transaction_id bigint references public.transactions (id),
  add column if not exists exit_reason text
    check (exit_reason is null or exit_reason in ('take-profit', 'stop-loss', 'interim-take-profit', 'interim-stop-loss'));

alter table public.positions
  add column if not exists opening_transaction_id bigint references public.transactions (id);

alter table public.balance_history
  add column if not exists spy_price numeric;

create index if not exists transactions_opening_transaction_id_idx
  on public.transactions (opening_transaction_id);

-- Nothing to backfill: existing rows simply have currency='USD', fx_fee=0,
-- signal_snapshot=null, opening_transaction_id=null, exit_reason=null,
-- spy_price=null — which accurately reflects "this data predates the
-- richer logging" rather than fabricating values we don't actually have.
