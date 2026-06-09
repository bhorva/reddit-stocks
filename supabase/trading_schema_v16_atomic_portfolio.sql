-- v16 — Atomic portfolio updates (race-condition fix)
-- ===================================================================
-- Problem this fixes
-- -------------------
-- `market-scan` and `price-refresh` both READ the singleton `portfolio`
-- row at the start of their run, mutate it in memory, and write the WHOLE
-- row back at the end (`update({ ...portfolio })`). When they overlap —
-- which they do regularly: market-scan runs every ~6h and takes 30-60s of
-- network I/O, price-refresh runs every ~15-30min and is fast — the slower
-- writer overwrites the faster one's changes with a stale base. A real
-- example: price-refresh sells a position (cash += proceeds, writes row),
-- then market-scan finishes and writes `cash` computed from the value it
-- read BEFORE that sale → the proceeds vanish from the books, even though
-- the position is gone and a sell transaction exists. The DELETE-first
-- guard added earlier protects the POSITION row from a double-sell, but it
-- never protected the portfolio AGGREGATE from this last-writer-wins clobber.
--
-- The fix
-- -------
-- Replace the full-row overwrite with an atomic, DB-side delta apply. Each
-- function tracks how much IT changed (cash/realized_pnl/total_fees/
-- trade_count) and calls this function, which increments those columns
-- inside a single UPDATE statement — so concurrent runs compose instead of
-- clobbering. `blocked_count` / `blocked_capital` are per-RUN absolute
-- values that ONLY market-scan computes (price-refresh never touches them),
-- so they are SET (via COALESCE: pass the value to set them, pass NULL to
-- leave them untouched) rather than incremented.
--
-- Apply once in the Supabase SQL editor (or via `supabase db push`). The
-- Edge Functions fall back to the old full-overwrite (with a loud log line)
-- until this exists, so deploying the functions first never breaks a run.

create or replace function public.apply_portfolio_delta(
  d_cash              numeric,
  d_realized_pnl      numeric,
  d_total_fees        numeric,
  d_trade_count       integer,
  set_blocked_count   integer default null,
  set_blocked_capital numeric default null
) returns void
language sql
as $$
  update public.portfolio
     set cash            = cash + d_cash,
         realized_pnl    = realized_pnl + d_realized_pnl,
         total_fees      = total_fees + d_total_fees,
         trade_count     = trade_count + d_trade_count,
         blocked_count   = coalesce(set_blocked_count, blocked_count),
         blocked_capital = coalesce(set_blocked_capital, blocked_capital),
         updated_at      = now()
   where id = true;
$$;

-- Only the service role (used by the Edge Functions) may call this; it must
-- never be reachable from the public/anon API surface.
revoke all on function public.apply_portfolio_delta(numeric, numeric, numeric, integer, integer, numeric) from public;
grant execute on function public.apply_portfolio_delta(numeric, numeric, numeric, integer, integer, numeric) to service_role;
