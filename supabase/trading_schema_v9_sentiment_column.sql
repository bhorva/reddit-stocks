-- ── Migration v9: persist StockTwits crowd-sentiment ratio per signal ────
--
-- WHY: `classify()` in market-scan/index.ts has computed a StockTwits
-- bullish/bearish ratio for every scanned ticker since the very first
-- version of the sentiment check (`sentimentRatio`, `null` when fewer than
-- 5 tagged messages exist — "not enough data", not "neutral 0%"). It is one
-- of five independent "is this organic?" lenses that decide the Verdict.
-- Until now, that number only survived the scan if a BUY happened — folded
-- into `transactions.signal_snapshot`. Every other signal row (the vast
-- majority: watched-but-not-bought tickers, "pure-hype" blocks, "spike"
-- watches) discarded it the instant the scan moved to the next ticker. That
-- made it impossible to show "what does the wider trading crowd think about
-- this ticker RIGHT NOW" in the watchlist — exactly the kind of "why did/
-- didn't the engine trade this" context a Hype-Score-only view can't give
-- (e.g. "loud on Reddit AND the crowd actually agrees" vs. "loud on Reddit
-- but the crowd thinks it's nonsense" look identical without this column).
--
-- Idempotent / additive, like v2-v8: existing rows simply get `null` — the
-- honest "not measured under this column yet" state, the same convention
-- already used for `drop_from_high_pct` / `is_etf` / `usd_chf_rate` etc.
-- No historical values are invented; nothing else changes.
--
-- After applying, redeploy market-scan so it actually starts WRITING the
-- column on every future scan:
--   supabase functions deploy market-scan

alter table public.signals
  add column if not exists sentiment_ratio numeric;

comment on column public.signals.sentiment_ratio is
  'StockTwits bullish / (bullish + bearish) ratio at scan time, range 0..1. '
  'NULL = fewer than 5 tagged messages were available — "not enough data for '
  'a meaningful read", not "neutral" (see fetchStockTwitsSentiment / classify '
  'in supabase/functions/market-scan/index.ts). Also NULL for rows recorded '
  'before this column existed.';
