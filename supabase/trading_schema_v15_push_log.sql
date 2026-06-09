-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v15: Push Notification Log
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Creates a log table for every ntfy push notification sent by the trading
-- engine. Both market-scan and price-refresh insert a row after each sendNtfy()
-- call. The dashboard loads this table alongside other trading data and
-- displays it in the Notification Center (bell icon, top-right in tab bar).
--
-- Idempotent (CREATE TABLE IF NOT EXISTS; DROP POLICY IF EXISTS).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.push_notifications (
  id          bigint generated always as identity primary key,
  title       text not null,
  message     text not null,
  topic       text not null default 'unknown',
  priority    int  not null default 3,
  tags        text[] not null default '{}',
  -- Semantic event type — used by the dashboard to colour-code entries.
  -- 'buy' | 'sell-tp' | 'sell-trailing-stop' |
  -- 'sell-interim-tp' | 'sell-interim-trailing-stop'
  -- NULL for legacy / pre-v15 rows (if any are backfilled manually).
  event_type  text,
  -- Ticker the notification relates to (NULL for non-trade system events).
  ticker      text,
  created_at  timestamptz not null default now()
);

alter table public.push_notifications enable row level security;

-- Same auth gate as all other trading tables (introduced in v8):
-- only authenticated sessions may read — no public read.
drop policy if exists "push_notifications_select" on public.push_notifications;
create policy "push_notifications_select" on public.push_notifications
  for select using (auth.role() = 'authenticated');

comment on table public.push_notifications is
  'Log of every ntfy push notification sent by the trading engine (market-scan '
  'and price-refresh Edge Functions). Written immediately after each sendNtfy() '
  'call — failure to write is non-fatal and does not affect the trade run. '
  'Feeds the in-app Notification Center: loaded alongside portfolio / transaction '
  'data on dashboard startup, no separate polling needed.';

comment on column public.push_notifications.event_type is
  'Semantic event type for UI colour-coding: '
  '''buy'' | ''sell-tp'' | ''sell-trailing-stop'' | ''sell-interim-tp'' | '
  '''sell-interim-trailing-stop''. NULL for legacy / pre-v15 rows.';

comment on column public.push_notifications.ticker is
  'Ticker symbol the event relates to (e.g. ''NVDA''). '
  'NULL for non-trade events (not currently produced but kept for forward-compat).';
