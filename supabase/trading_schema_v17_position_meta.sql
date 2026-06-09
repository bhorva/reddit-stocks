-- v17 — Persist the data price-refresh needs for a verdict-aware trailing stop
-- ===================================================================
-- Why
-- ---
-- The intelligent sell/hold gate suppresses the trailing stop while a position
-- is still "buy-eligible" (organic + in the dip range), so the engine never
-- churns out a position it would immediately re-open. That decision needs the
-- ticker's `verdict` and its multi-week high (to compute the dip) — both of
-- which only `market-scan` computes. So `price-refresh` (which re-prices every
-- ~15-30min but never classifies) was left enforcing ONLY the unconditional
-- exits (take-profit + hard-stop), and the verdict-aware trailing stop ran just
-- once every ~6h in market-scan. A winner that peaked and slid back BETWEEN two
-- scans therefore gave back profit until the next full scan.
--
-- The fix stores the two missing inputs on the position row every market-scan:
--   * recent_high   — the multi-week high (max of ~30 daily closes) used as the
--                     reference for dropFromHigh; price-refresh recomputes the
--                     dip from its OWN fresh price against this stored high.
--   * last_verdict  — the most recent classification ('organic' | 'spike' |
--                     'pure-hype'); price-refresh uses it as a conservative
--                     proxy (a verdict doesn't flip in 15-30min, and a falling
--                     price only makes the dip deeper → more buy-eligible).
-- With these present, price-refresh applies the SAME wouldBuyNow suppression as
-- market-scan, so frequent profit-locking is restored WITHOUT reintroducing the
-- churn. Until this migration is applied the columns are simply absent →
-- price-refresh falls back to its pre-v17 TP+hard-stop-only behaviour (safe:
-- it never sells something market-scan would hold without the data to prove it).

alter table public.positions
  add column if not exists recent_high  numeric,
  add column if not exists last_verdict text;

comment on column public.positions.recent_high is
  'v17: multi-week high (max of ~30 daily closes) from the last market-scan; price-refresh recomputes dropFromHigh against this for its verdict-aware trailing stop.';
comment on column public.positions.last_verdict is
  'v17: most recent classification verdict from market-scan; price-refresh uses it (with recent_high) to mirror the wouldBuyNow trailing-stop suppression between full scans.';
