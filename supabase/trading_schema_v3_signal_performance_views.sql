-- Migration v3 — run this in the Supabase SQL editor AFTER
-- trading_schema_v2_migration.sql has been applied. Purely additive
-- (CREATE OR REPLACE VIEW + GRANT) and safe to re-run.
--
-- WHY: v2 started capturing a structured `signal_snapshot` (hype score,
-- z-score, sentiment ratio, price trend, verdict, ...) on every BUY, and
-- linking SELLs back to their opening BUY via `opening_transaction_id`. That
-- data is useless sitting in a JSONB blob though — these views turn it into
-- the two questions that actually matter for improving the heuristics:
--
--   1. "Does the verdict classification (organic / spike / pure-hype) predict
--      whether a trade ends up profitable?" — if `pure-hype` trades (which
--      shouldn't even be reachable, since they're blocked) or `spike` trades
--      perform as well as `organic` ones, the classification isn't adding
--      value and the thresholds need rethinking.
--
--   2. "Does a higher z-score (stronger mention spike vs. baseline) correlate
--      with better or worse outcomes?" — bucketed so you can see at a glance
--      whether extreme spikes are early signal or late-stage hype about to
--      reverse (which is exactly the ambiguity the heuristic tries to resolve).
--
-- Both views only consider CLOSED, LINKED trades (sell rows with a
-- `realized_pnl` and a resolvable `opening_transaction_id` -> buy row with a
-- `signal_snapshot`) — i.e. only data logged after the v2 migration. Until
-- enough trades have accumulated this way, these views will simply return few
-- or no rows; that's expected, not a bug (see README "Prozess-Verbesserungen
-- v2" for why we don't backfill historical rows with fabricated values).
--
-- Suggested usage once there's enough data (rule of thumb: don't draw
-- conclusions from fewer than ~20-30 trades per group — that's the difference
-- between "the heuristic works" and "we got lucky/unlucky three times"):
--
--   select * from public.trade_outcomes_by_verdict;
--   select * from public.trade_outcomes_by_zscore_bucket;

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
  count(*) filter (where sell.exit_reason ilike 'stop-loss%')   as exits_stop_loss
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
  'whether a trade is profitable?". Only includes trades logged after the v2 '
  'migration (signal_snapshot + opening_transaction_id required).';

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
  round(avg((buy.signal_snapshot ->> 'price_trend_pct')::numeric), 2) as avg_price_trend_pct
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
  'or is z-score not actually informative beyond a certain point?". Only '
  'includes trades logged after the v2 migration.';

-- ── Read access ──────────────────────────────────────────────────────────────
-- Views on tables with RLS "public read" policies (see trading_schema.sql)
-- still need an explicit GRANT for the anon/authenticated roles Supabase's
-- PostgREST API uses — table-level RLS alone doesn't imply view access.
grant select on public.trade_outcomes_by_verdict       to anon, authenticated;
grant select on public.trade_outcomes_by_zscore_bucket to anon, authenticated;
