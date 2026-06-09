-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v10: CNN Fear & Greed Index gate + Yahoo Finance Trending signal
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds three columns:
--
--   signals.fear_greed_score  smallint   — CNN F&G score (0–100) fetched once
--                                          at scan start, written to EVERY signal
--                                          row in that run. NULL for legacy rows
--                                          (before this migration). Score < 40 at
--                                          scan time means the buy-gate was active
--                                          (no new positions opened, existing
--                                          stop-loss/take-profit run unchanged).
--
--   signals.yf_trending       boolean    — true iff the ticker appeared on the
--                                          Yahoo Finance US trending list at scan
--                                          time. Informative only — no effect on
--                                          buy/sell logic (yet). NOT NULL, default
--                                          false so legacy rows show "not trending"
--                                          rather than "unknown".
--
--   balance_history.fear_greed_score  smallint  — same score stored on the
--                                                  balance snapshot for the run,
--                                                  so the dashboard can derive the
--                                                  "latest" score from balance_history
--                                                  even during scan runs that produce
--                                                  no new signals. NULL for legacy rows.
--
-- Idempotent (safe to re-run): uses ADD COLUMN IF NOT EXISTS throughout.

alter table public.signals
  add column if not exists fear_greed_score smallint,
  add column if not exists yf_trending      boolean not null default false;

comment on column public.signals.fear_greed_score is
  'CNN Fear & Greed Index score (0–100) at scan time. NULL = predates v10 migration. Score < 40 means the buy-gate was active for this run.';

comment on column public.signals.yf_trending is
  'True iff this ticker appeared on Yahoo Finance US Trending at scan time. Informative only — no trade-logic effect. False for legacy rows.';

alter table public.balance_history
  add column if not exists fear_greed_score smallint;

comment on column public.balance_history.fear_greed_score is
  'CNN Fear & Greed Index score (0–100) at snapshot time. NULL = predates v10 migration.';
