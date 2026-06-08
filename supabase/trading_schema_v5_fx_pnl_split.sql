-- Migration v5 — run this in the Supabase SQL editor AFTER
-- trading_schema_v4_fx_rate.sql has been applied. Purely additive
-- (CREATE OR REPLACE VIEW + GRANT) and safe to re-run.
--
-- NOTE on column order: Postgres' CREATE OR REPLACE VIEW only allows APPENDING
-- columns — inserting a new one between existing columns makes it think you're
-- renaming an existing column and fails with "42P16 cannot change name of view
-- column ... HINT: Use ALTER VIEW ... RENAME COLUMN ...". That's why every new
-- FX-adjusted column below is appended at the end of its SELECT list, after
-- all the original v3 columns (which keep their exact name + position).
--
-- WHY: v4 introduced a real USD/CHF exchange-rate model, so a closed trade's
-- `realized_pnl` (in CHF) is now a BLEND of two economically unrelated things:
--
--   1. "Trading P&L"  — did the stock move the way the heuristic expected?
--   2. "FX P&L"       — did USD/CHF drift favourably or unfavourably while the
--                        position was open (pure currency luck, nothing to do
--                        with the hype classification at all)?
--
-- The v3 views (`trade_outcomes_by_verdict`, `trade_outcomes_by_zscore_bucket`)
-- classify wins/losses and average P&L purely off `realized_pnl`. That made
-- perfect sense when 1 USD ≈ 1 CHF was assumed — but now a textbook-perfect
-- "organic" call can show up as a LOSS purely because the franc strengthened
-- during the hold, or a mediocre pick can look like a WIN because the dollar
-- happened to rally. That's currency noise drowning out exactly the signal
-- these views exist to measure ("does our hype classification predict whether
-- a trade is profitable?").
--
-- HOW: the split below is derived directly from the `realized_pnl` formula the
-- Edge Functions actually use (`proceeds - costBasis - fees`, where both sides
-- are converted to CHF at their own moment's FX rate):
--
--   realized_pnl = shares · (exit_price · exit_fx − entry_price · entry_fx) − fees
--                = [ shares · entry_fx · (exit_price − entry_price) − fees ]   (= trading_pnl)
--                + [ shares · exit_price · (exit_fx − entry_fx) ]              (= fx_pnl)
--
-- `trading_pnl` values the stock-price move at a CONSTANT exchange rate (the
-- one that applied at entry) — i.e. "what this trade would have made if the
-- franc had stood still". That isolates exactly what the heuristic tries to
-- predict. `fx_pnl` is the leftover currency-drift component. Both summed give
-- back the true `realized_pnl` (the actual CHF impact on the account) — kept
-- alongside for the "what really happened to the money" perspective.
--
-- Legacy rows (pre-v4, `usd_chf_rate is null` on one or both sides) coalesce
-- to 1.0 — not a fabricated value, but literally the "1 USD ≈ 1 CHF" the
-- simulation assumed at the time those trades were logged, so `fx_pnl` comes
-- out to exactly 0 for them (correctly: no FX model existed yet to drift).
--
-- Suggested usage once there's enough data (same ~20-30 trades/group rule of
-- thumb as v3 — and now doubly important, since splitting into smaller
-- components only amplifies small-sample noise):
--
--   select * from public.trade_outcomes_by_verdict;
--   select * from public.trade_outcomes_by_zscore_bucket;
--
-- If `trading_win_rate_pct` and `win_rate_pct` diverge noticeably for a group,
-- that's the FX drift talking — not the heuristic.

-- ── View 1: outcomes grouped by the verdict the engine assigned at BUY time ──
create or replace view public.trade_outcomes_by_verdict as
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
  count(*) filter (where sell.exit_reason ilike 'take-profit%') as exits_take_profit,
  count(*) filter (where sell.exit_reason ilike 'stop-loss%')   as exits_stop_loss,
  -- ── FX-bereinigte Sicht: war die Aktien-Auswahl gut, unabhängig vom Kurs? ──
  -- (ans Ende angehängt, NICHT zwischen bestehende Spalten eingefügt — Postgres
  -- behandelt CREATE OR REPLACE VIEW sonst als "Spalte umbenennen" und lehnt es
  -- mit 42P16 ab; neue Spalten dürfen nur am Ende angehängt werden.)
  round(
    100.0 * count(*) filter (
      where sell.shares
              * coalesce(buy.usd_chf_rate, 1.0)
              * (sell.price - buy.price)
            - (coalesce(sell.fee, 0) + coalesce(sell.fx_fee, 0)
               + coalesce(buy.fee, 0) + coalesce(buy.fx_fee, 0))
            > 0
    ) / nullif(count(*), 0),
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
  )                                                         as avg_fx_pnl
from public.transactions sell
join public.transactions buy on buy.id = sell.opening_transaction_id
where sell.action = 'sell'
  and sell.realized_pnl is not null
  and buy.signal_snapshot is not null
group by coalesce(buy.signal_snapshot ->> 'verdict', 'unbekannt')
order by closed_trades desc;

comment on view public.trade_outcomes_by_verdict is
  'Closed-trade outcomes grouped by the verdict (organic/spike/pure-hype) the '
  'engine assigned at BUY time — answers "does our hype classification predict '
  'whether a trade is profitable?". Includes both the all-in CHF view '
  '(win_rate_pct/avg_realized_pnl, what actually happened to the account) and '
  'an FX-adjusted view (trading_win_rate_pct/avg_trading_pnl/avg_fx_pnl, which '
  'isolates "was the stock pick good?" from "did the franc happen to move in '
  'our favour?" — see trading_schema_v5_fx_pnl_split.sql for the derivation). '
  'Only includes trades logged after the v2 migration (signal_snapshot + '
  'opening_transaction_id required).';

-- ── View 2: outcomes bucketed by the z-score recorded at BUY time ───────────
-- Buckets follow standard statistical convention (±1σ / ±2σ / beyond) so the
-- groups map directly onto "how unusual was this mention spike, really?".
create or replace view public.trade_outcomes_by_zscore_bucket as
select
  case
    when (buy.signal_snapshot ->> 'z_score')::numeric < 1   then 'z < 1 (unauffällig)'
    when (buy.signal_snapshot ->> 'z_score')::numeric < 2   then '1 ≤ z < 2 (erhöht)'
    when (buy.signal_snapshot ->> 'z_score')::numeric < 3   then '2 ≤ z < 3 (deutlicher Spike)'
    else                                                          'z ≥ 3 (extremer Spike)'
  end                                                       as z_score_bucket,
  count(*)                                                  as closed_trades,
  count(*) filter (where sell.realized_pnl > 0)             as wins,
  round(
    100.0 * count(*) filter (where sell.realized_pnl > 0) / nullif(count(*), 0),
    1
  )                                                         as win_rate_pct,
  round(avg(sell.realized_pnl), 2)                          as avg_realized_pnl,
  round(avg((buy.signal_snapshot ->> 'z_score')::numeric), 2) as avg_z_score_in_bucket,
  round(avg((buy.signal_snapshot ->> 'price_trend_pct')::numeric), 2) as avg_price_trend_pct,
  -- ── FX-bereinigte Sicht (ans Ende angehängt — siehe Begründung/Hinweis bei
  -- trade_outcomes_by_verdict oben: CREATE OR REPLACE VIEW erlaubt nur
  -- Anhängen, kein Einfügen zwischen bestehenden Spalten, sonst 42P16) ────────
  round(
    100.0 * count(*) filter (
      where sell.shares
              * coalesce(buy.usd_chf_rate, 1.0)
              * (sell.price - buy.price)
            - (coalesce(sell.fee, 0) + coalesce(sell.fx_fee, 0)
               + coalesce(buy.fee, 0) + coalesce(buy.fx_fee, 0))
            > 0
    ) / nullif(count(*), 0),
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
  )                                                         as avg_trading_pnl
from public.transactions sell
join public.transactions buy on buy.id = sell.opening_transaction_id
where sell.action = 'sell'
  and sell.realized_pnl is not null
  and buy.signal_snapshot is not null
  and buy.signal_snapshot ->> 'z_score' is not null
group by z_score_bucket
order by min((buy.signal_snapshot ->> 'z_score')::numeric);

comment on view public.trade_outcomes_by_zscore_bucket is
  'Closed-trade outcomes bucketed by the mention-count z-score recorded at BUY '
  'time — answers "do stronger mention spikes predict better or worse outcomes, '
  'or is z-score not actually informative beyond a certain point?". Includes '
  'both the all-in CHF view and an FX-adjusted view (trading_win_rate_pct / '
  'avg_trading_pnl) that isolates the stock-picking signal from currency drift '
  '— see trading_schema_v5_fx_pnl_split.sql for the derivation. Only includes '
  'trades logged after the v2 migration.';

-- ── Read access ──────────────────────────────────────────────────────────────
-- Views on tables with RLS "public read" policies (see trading_schema.sql)
-- still need an explicit GRANT for the anon/authenticated roles Supabase's
-- PostgREST API uses — table-level RLS alone doesn't imply view access.
-- (Re-granting on CREATE OR REPLACE is harmless but cheap insurance in case a
-- future Postgres version ever revokes on replace.)
grant select on public.trade_outcomes_by_verdict       to anon, authenticated;
grant select on public.trade_outcomes_by_zscore_bucket to anon, authenticated;
