-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query),
-- after schema.sql. It creates the tables for the pump-&-dip trading
-- simulation, seeds a watchlist, and sets up a 6-hourly cron job that
-- triggers the `market-scan` Edge Function.
--
-- All tables here are written ONLY by the `market-scan` Edge Function (using
-- the service-role key, which bypasses RLS). The public "anon" key can read
-- but never write — the simulation must not be tamperable from the browser.

-- ── Watchlist: tickers that the scan evaluates each run ──────────────────
create table if not exists public.watchlist (
  ticker  text    primary key,
  name    text    not null,
  active  boolean not null default true
);

insert into public.watchlist (ticker, name) values
  ('RDDT', 'Reddit Inc.'),
  ('NVDA', 'NVIDIA Corp.'),
  ('MSFT', 'Microsoft Corp.'),
  ('META', 'Meta Platforms'),
  ('AMZN', 'Amazon.com Inc.'),
  ('GOOGL','Alphabet Inc.'),
  ('AAPL', 'Apple Inc.'),
  ('AMD',  'Advanced Micro Devices'),
  ('GME',  'GameStop Corp.'),
  ('AMC',  'AMC Entertainment')
on conflict (ticker) do nothing;

-- ── Signals: one row per ticker per scan run ─────────────────────────────
create table if not exists public.signals (
  id             bigint generated always as identity primary key,
  ticker         text        not null references public.watchlist (ticker),
  scanned_at     timestamptz not null default now(),
  price          numeric     not null,
  mention_count  integer     not null default 0,
  hype_score     numeric     not null default 0,
  verdict        text        not null check (verdict in ('organic', 'spike', 'pure-hype')),
  blocked        boolean     not null default false,
  reason         text        not null default ''
);

create index if not exists signals_ticker_scanned_at_idx
  on public.signals (ticker, scanned_at desc);

-- ── Portfolio: singleton row tracking cash & aggregate stats ─────────────
create table if not exists public.portfolio (
  id              boolean      primary key default true check (id),
  cash            numeric      not null default 10000,
  realized_pnl    numeric      not null default 0,
  total_fees      numeric      not null default 0,
  trade_count     integer      not null default 0,
  blocked_count   integer      not null default 0,
  blocked_capital numeric      not null default 0,
  updated_at      timestamptz  not null default now()
);

insert into public.portfolio (id) values (true) on conflict (id) do nothing;

-- ── Positions: currently open holdings ────────────────────────────────────
create table if not exists public.positions (
  id          bigint generated always as identity primary key,
  ticker      text        not null references public.watchlist (ticker),
  shares      numeric     not null,
  entry_price numeric     not null,
  opened_at   timestamptz not null default now()
);

-- ── Transactions: the buy/sell log required by the simulation ─────────────
create table if not exists public.transactions (
  id            bigint generated always as identity primary key,
  ticker        text        not null references public.watchlist (ticker),
  action        text        not null check (action in ('buy', 'sell')),
  shares        numeric     not null,
  price         numeric     not null,
  fee           numeric     not null,
  gross_amount  numeric     not null,
  realized_pnl  numeric,
  reason        text        not null default '',
  created_at    timestamptz not null default now()
);

create index if not exists transactions_created_at_idx
  on public.transactions (created_at desc);

-- ── Balance history: one snapshot per scan run, for the chart ────────────
create table if not exists public.balance_history (
  id               bigint generated always as identity primary key,
  recorded_at      timestamptz not null default now(),
  cash             numeric     not null,
  positions_value  numeric     not null,
  total_value      numeric     not null
);

insert into public.balance_history (cash, positions_value, total_value)
  select 10000, 0, 10000
  where not exists (select 1 from public.balance_history);

-- ── Row Level Security: public read-only ─────────────────────────────────
alter table public.watchlist       enable row level security;
alter table public.signals         enable row level security;
alter table public.portfolio       enable row level security;
alter table public.positions       enable row level security;
alter table public.transactions    enable row level security;
alter table public.balance_history enable row level security;

create policy "Public read access" on public.watchlist       for select using (true);
create policy "Public read access" on public.signals         for select using (true);
create policy "Public read access" on public.portfolio       for select using (true);
create policy "Public read access" on public.positions       for select using (true);
create policy "Public read access" on public.transactions    for select using (true);
create policy "Public read access" on public.balance_history for select using (true);

-- No insert/update/delete policies are defined for the anon role on these
-- tables: only the service-role key (used by the Edge Function) can write,
-- since it bypasses RLS entirely.

-- ── Cron: trigger the market-scan Edge Function every 6 hours ────────────
-- One-time manual setup (cannot be scripted — needs your project's URL/keys):
--
-- 1. In the SQL editor, enable the required extensions:
--      create extension if not exists pg_cron;
--      create extension if not exists pg_net;
--
-- 2. Deploy the Edge Function (see supabase/functions/market-scan):
--      supabase functions deploy market-scan
--      supabase secrets set REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...
--
-- 3. Store the function URL and the service-role key as Vault secrets
--    (Project Settings -> Vault), then schedule the job. Replace the
--    placeholders below with your actual project ref and run once:
--
--      select cron.schedule(
--        'market-scan-every-6h',
--        '0 */6 * * *',
--        $$
--        select net.http_post(
--          url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/market-scan',
--          headers := jsonb_build_object(
--            'Content-Type',  'application/json',
--            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
--          ),
--          body    := '{}'::jsonb
--        );
--        $$
--      );
--
-- To inspect or remove the schedule later:
--      select * from cron.job;
--      select cron.unschedule('market-scan-every-6h');
