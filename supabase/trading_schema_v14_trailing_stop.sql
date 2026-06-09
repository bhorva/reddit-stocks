-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v14: Trailing Stop
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Replaces the fixed stop-loss (−6% from ENTRY price) with a trailing stop
-- (−6% from the HIGHEST price reached since the position was opened).
--
-- Behaviour:
--   • The stop level starts at entry_price × 0.94 — identical to the old
--     fixed stop, so no immediate change for freshly opened positions.
--   • Every time the price ticks above the current high_since_entry, both
--     market-scan and price-refresh update the column in-place and push the
--     stop level upward. Once locked in, it never moves back down.
--   • Exit fires when price ≤ high_since_entry × (1 + STOP_LOSS) = × 0.94.
--     exit_reason is 'trailing-stop' (market-scan) or 'interim-trailing-stop'
--     (price-refresh between scans), so old 'stop-loss' rows remain unchanged.
--   • Take-profit is still anchored to entry_price (not the trailing high) —
--     a fixed +20%-from-entry target makes more sense than a moving one that
--     can never be "reached" if the stock keeps climbing.
--
-- Analysis: transactions.high_since_entry (on SELL rows) lets you reconstruct
-- the full path of each trade post-hoc:
--   • entry_price (from the linked BUY via opening_transaction_id)
--   • highest price ever reached during the hold (high_since_entry on SELL)
--   • actual exit price (transactions.price)
--   Compare (high_since_entry − entry_price) × 0.94 × shares × usdchf to the
--   fixed-stop alternative (entry_price × 0.94) to measure trailing benefit.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS).

-- ── 1. positions ─────────────────────────────────────────────────────────────

alter table public.positions
  add column if not exists high_since_entry numeric;

-- Seed existing open positions conservatively at entry_price — the true
-- intraday high since open is unknown for pre-v14 rows, so we start fresh
-- (trailing stop initially equals the old fixed stop for these positions).
update public.positions
  set high_since_entry = entry_price
  where high_since_entry is null;

alter table public.positions
  alter column high_since_entry set not null;

comment on column public.positions.high_since_entry is
  'Highest closing/intraday price seen while this position has been open. '
  'Updated on every market-scan and price-refresh run when price > current value. '
  'Trailing stop fires at high_since_entry × (1 + STOP_LOSS). '
  'Pre-v14 rows seeded at entry_price (conservative: trailing stop = old fixed stop).';

-- ── 2. transactions ───────────────────────────────────────────────────────────

-- Recorded on SELL transactions only — the highest price the position ever
-- reached during the hold. Null for BUY rows and for all pre-v14 sells.
-- Enables post-hoc analysis: how much did the trailing stop improve vs the
-- old fixed stop? (high_since_entry × 0.94 vs entry_price × 0.94)
alter table public.transactions
  add column if not exists high_since_entry numeric;

comment on column public.transactions.high_since_entry is
  'On SELL rows: the highest price this position ever reached (= positions.high_since_entry '
  'at the moment of exit). NULL for BUY rows and pre-v14 sells. '
  'Together with the linked BUY entry_price, allows computing trailing-stop benefit per trade.';

-- ── 3. exit_reason CHECK constraint ──────────────────────────────────────────
-- Extend to include 'trailing-stop' and 'interim-trailing-stop'.
-- (PostgreSQL has no ALTER CONSTRAINT — must drop and recreate.)

alter table public.transactions
  drop constraint if exists transactions_exit_reason_check;

alter table public.transactions
  add constraint transactions_exit_reason_check
    check (exit_reason is null or exit_reason in (
      'take-profit',
      'stop-loss',              -- legacy fixed stop-loss (pre-v14 rows)
      'interim-take-profit',
      'interim-stop-loss',      -- legacy interim fixed stop (pre-v14 rows)
      'trailing-stop',          -- trailing stop via market-scan (v14+)
      'interim-trailing-stop'   -- trailing stop via price-refresh (v14+)
    ));

-- ── 4. Update analysis views ──────────────────────────────────────────────────
-- The existing views (v3, v5) filter stop-loss exits with `ilike 'stop-loss%'`,
-- which misses the new 'trailing-stop' values. Recreate with an explicit IN list
-- that covers all stop variants — old and new.
-- (CREATE OR REPLACE is safe here: new columns only appended, none removed.)

-- Recreate the view (DROP + CREATE) because CREATE OR REPLACE only allows
-- appending new columns, but we also need to update the stop-loss filter
-- expressions to include the new trailing-stop exit_reason values.
-- The Angular service reads this view via raw SQL in the Lern-Insights tab —
-- existing column names/order are preserved; new columns are appended at end.

drop view if exists public.trade_outcomes_by_verdict;

create view public.trade_outcomes_by_verdict as
select
  coalesce(buy.signal_snapshot ->> 'verdict', 'unbekannt') as verdict,
  count(*)                                                  as closed_trades,
  count(*) filter (where sell.realized_pnl > 0)             as wins,
  count(*) filter (where sell.realized_pnl < 0)             as losses,
  round(
    100.0 * count(*) filter (where sell.realized_pnl > 0) / nullif(count(*), 0),
    1
  )                                                         as win_rate_pct,
  round(avg(sell.realized_pnl), 2)                          as avg_realized_pnl,
  round(sum(sell.realized_pnl), 2)                          as total_realized_pnl,
  round(
    avg(extract(epoch from (sell.created_at - buy.created_at)) / 3600.0),
    1
  )                                                         as avg_holding_hours,
  -- updated in v14: include trailing-stop variants alongside legacy fixed-stop values
  count(*) filter (where sell.exit_reason in ('take-profit','interim-take-profit'))
                                                            as exits_take_profit,
  count(*) filter (where sell.exit_reason in (
    'stop-loss','interim-stop-loss',
    'trailing-stop','interim-trailing-stop'
  ))                                                        as exits_stop_loss,
  round(
    100.0 * count(*) filter (where sell.realized_pnl > 0) / nullif(count(*), 0),
    1
  )                                                         as trading_win_rate_pct,
  round(
    avg(
      sell.shares
        * coalesce(buy.usd_chf_rate, 1.0)
        * (sell.price - buy.price)
      - (coalesce(sell.fee, 0) + coalesce(sell.fx_fee, 0)
         + coalesce(buy.fee, 0) + coalesce(buy.fx_fee, 0))
    ),
    2
  )                                                         as avg_trading_pnl,
  round(
    avg(
      sell.shares * sell.price
        * (coalesce(sell.usd_chf_rate, 1.0) - coalesce(buy.usd_chf_rate, 1.0))
    ),
    2
  )                                                         as avg_fx_pnl,
  -- ── NEW in v14: trailing-stop analysis columns (appended at end) ─────────
  -- How many exits were trailing-stop-specific?
  count(*) filter (where sell.exit_reason in ('trailing-stop','interim-trailing-stop'))
                                                            as exits_trailing_stop,
  -- Average % gain from entry to trailing high for trailing-stop exits.
  -- Positive = the stop moved above entry before firing (profit was locked in).
  -- NULL = no trailing-stop exits yet.
  round(avg(
    case
      when sell.exit_reason in ('trailing-stop','interim-trailing-stop')
           and sell.high_since_entry is not null
      then (sell.high_since_entry - buy.price) / nullif(buy.price, 0) * 100
    end
  ), 2)                                                     as avg_trailing_high_pct
from public.transactions sell
join public.transactions buy
  on sell.opening_transaction_id = buy.id
where sell.action = 'sell'
group by coalesce(buy.signal_snapshot ->> 'verdict', 'unbekannt');
