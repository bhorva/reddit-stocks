-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v11: Fear & Greed gate logging for future strategy analysis
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds one column to `signals`:
--
--   signals.skipped_for_fear_greed  boolean  — mirrors `skipped_for_capacity`
--     (see trading_schema_v6_missed_opportunities.sql) but for the F&G gate:
--     true iff ALL of the following hold at scan time:
--       • fear_greed_score < 40 (gate was active)
--       • market was open
--       • no existing position in this ticker
--       • verdict = 'organic'
--       • instrumentType != 'ETF'
--       • drop_from_high_pct <= DIP_THRESH
--     i.e. "the engine would have bought, but the F&G gate stopped it."
--
--   This is the explicit counterpart to what skipped_for_capacity tracks:
--   capacity blocks ("all 3 slots full") vs. macro blocks ("market too fearful").
--   Keeping them separate lets you later ask:
--     • "Were F&G-gated signals profitable opportunities we missed?"
--     • "Does gating at <40 improve or hurt net performance vs. not gating?"
--
--   false for legacy rows — pre-v10 rows never had a gate, so "not gated"
--   is the accurate representation rather than "unknown".
--
-- Idempotent (ADD COLUMN IF NOT EXISTS).

alter table public.signals
  add column if not exists skipped_for_fear_greed boolean not null default false;

comment on column public.signals.skipped_for_fear_greed is
  'True iff all buy conditions were met (organic, dip, market open, no existing position, not ETF) but the CNN Fear & Greed gate (score < 40) was the sole reason no position was opened. Analogous to skipped_for_capacity. false for legacy rows (pre-v10, gate did not exist).';
