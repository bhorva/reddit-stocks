-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query) to
-- reset the pump-&-dip / swing-trading simulation back to its starting state:
-- 10'000 CHF cash, no open positions, no transaction history.
--
-- Why you'd want this: the strategy has gone through several redesigns since
-- it first went live (pump-&-dip -> swing trading, 5-lens "organic"
-- classification, real US-market-hours gating, ...). Positions opened under
-- an earlier, less-refined heuristic don't reflect what the CURRENT engine
-- would actually buy — wiping the slate lets the new logic start clean and
-- makes the dashboard's numbers ("realisierte Gewinne", "Trefferquote", ...)
-- meaningfully reflect the strategy as it stands today, not a mix of eras.
--
-- Can be re-run any time you want a fresh start; it's fully idempotent.
--
-- Deliberately LEAVES UNTOUCHED:
--   * `watchlist`  — continuously rediscovered from trending Reddit posts by
--                    `market-scan` regardless; no need to reseed.
--   * `signals`    — the scan history. Keeping it preserves the "Letzter
--                    Scan"-freshness indicator and the hype/verdict
--                    classification log, which is independent of whether any
--                    position was ever opened from a given signal.
-- Both are read-only reference/observation data, not "trading state" — only
-- `transactions`, `positions`, `balance_history`, and the `portfolio`
-- singleton actually encode "what has the simulation done so far".

begin;

delete from public.transactions;
delete from public.positions;
delete from public.balance_history;

-- Re-seed a single starting snapshot so the chart has a sensible first point
-- again, mirroring the original bootstrap row in trading_schema.sql.
insert into public.balance_history (cash, positions_value, total_value)
values (10000, 0, 10000);

update public.portfolio
set cash            = 10000,
    realized_pnl    = 0,
    total_fees      = 0,
    trade_count     = 0,
    blocked_count   = 0,
    blocked_capital = 0,
    updated_at      = now()
where id = true;

commit;

-- Sanity check — should show cash = 10'000 and all counters at 0:
--   select * from public.portfolio;
--   select count(*) from public.positions;     -- expect 0
--   select count(*) from public.transactions;  -- expect 0
--   select * from public.balance_history;      -- expect exactly 1 row (10000/0/10000)
