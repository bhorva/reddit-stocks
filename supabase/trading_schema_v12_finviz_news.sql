-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v12: FinViz mainstream-news presence flag
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds one column to `signals`:
--
--   signals.finviz_news  boolean  — true iff the ticker appeared in at least
--     one FinViz news headline at scan time (fetched from finviz.com/news.ashx,
--     tickers extracted via /stock?t=TICKER href pattern).
--
--   Informative only — does NOT change buy/sell logic. Stored so we can later
--   analyse whether mainstream-news-backed organic signals outperform
--   Reddit-only ones. The temporal lag (news often follows Reddit hype by 1–3
--   days for meme stocks) means absence of news is NOT a red flag — see the
--   dashboard comment and trading_schema_v12 design notes.
--
--   NOT NULL DEFAULT false: legacy rows show "not in news" rather than
--   "unknown" — consistent with the yf_trending convention (v10).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS).

alter table public.signals
  add column if not exists finviz_news boolean not null default false;

comment on column public.signals.finviz_news is
  'True iff this ticker appeared in FinViz mainstream-news headlines at scan time. Informative only — no trade-logic effect. False for legacy rows (pre-v12). Useful for post-hoc analysis: do news-backed organic signals outperform Reddit-only ones?';
