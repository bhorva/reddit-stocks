-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query),
-- after schema.sql. It creates the tables for the pump-&-dip trading
-- simulation, seeds a watchlist, and sets up a 6-hourly cron job that
-- triggers the `market-scan` Edge Function.
--
-- All tables here are written ONLY by the `market-scan` Edge Function (using
-- the service-role key, which bypasses RLS). The public "anon" key can read
-- but never write — the simulation must not be tamperable from the browser.

-- ── Watchlist: tickers the scan currently considers "hot" ────────────────
-- This table is fully dynamic: each run extracts ticker symbols straight out
-- of trending Reddit posts (cashtags + validated all-caps words), so it is
-- reseeded with whatever the engine discovers — `name` is therefore optional
-- (only known for the seed rows below) and `active` reflects whether a ticker
-- made the current top-N "hot" cut (or still has an open position).
create table if not exists public.watchlist (
  ticker         text        primary key,
  name           text,
  active         boolean     not null default true,
  discovered_at  timestamptz not null default now()
);

-- Bootstrap rows so the dashboard isn't empty before the first scan. The
-- engine will mark these inactive (and add/replace others) the moment they
-- stop showing up among the currently-trending tickers it discovers.
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

-- `create policy` has no `if not exists` clause, so re-running this script
-- (e.g. after adjusting the schema) would otherwise fail with
-- "policy ... already exists". Drop-then-create makes it idempotent.
drop policy if exists "Public read access" on public.watchlist;
drop policy if exists "Public read access" on public.signals;
drop policy if exists "Public read access" on public.portfolio;
drop policy if exists "Public read access" on public.positions;
drop policy if exists "Public read access" on public.transactions;
drop policy if exists "Public read access" on public.balance_history;

create policy "Public read access" on public.watchlist       for select using (true);
create policy "Public read access" on public.signals         for select using (true);
create policy "Public read access" on public.portfolio       for select using (true);
create policy "Public read access" on public.positions       for select using (true);
create policy "Public read access" on public.transactions    for select using (true);
create policy "Public read access" on public.balance_history for select using (true);

-- No insert/update/delete policies are defined for the anon role on these
-- tables: only the service-role key (used by the Edge Function) can write,
-- since it bypasses RLS entirely.

-- ── Cron: trigger the market-scan Edge Function during trading hours ─────
-- One-time manual setup (cannot be scripted — needs your project's URL/keys):
--
-- 1. In the SQL editor, enable the required extensions:
--      create extension if not exists pg_cron;
--      create extension if not exists pg_net;
--
-- 2. Deploy the Edge Function (see supabase/functions/market-scan):
--      supabase functions deploy market-scan
--    No Reddit app/secrets needed — the function reads Reddit's public
--    JSON endpoints (www.reddit.com/.../*.json) with just a User-Agent
--    header, since self-service OAuth credential creation is now gated
--    behind a multi-week manual review (see README "Trading-Simulation").
--
-- 3. Store the function URL and the service-role key as Vault secrets
--    (Project Settings -> Vault), then schedule the job. Replace the
--    placeholders below with your actual project ref and run once:
--
--      select cron.schedule(
--        'market-scan-during-trading-hours',
--        '0 15,17,19 * * 1-5',
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
-- WHY '0 15,17,19 * * 1-5' (15:00 / 17:00 / 19:00 UTC, Mon-Fri) and not the
-- earlier round-the-clock '0 */6 * * *':
--
--   NYSE/NASDAQ regular hours are 09:30-16:00 America/New_York, which — across
--   the EDT/EST daylight-saving switch — lands somewhere in 13:30-21:00 UTC.
--   The OLD schedule (00:00/06:00/12:00/18:00 UTC, every day) put only ONE of
--   its four daily runs inside that window; the other three (and EVERY weekend
--   run) could only log signals — `isUsMarketOpen` would refuse to let them
--   buy or sell, exactly like a real Swissquote account couldn't fill a
--   US-equity order outside the exchange's session either (see that function's
--   comment for the full reasoning).
--
--   13:30-21:00 (EDT) ∩ 14:30-21:00 (EST) = 14:30-21:00 UTC is the overlap
--   that's open REGARDLESS of which side of the DST switch you're on — no
--   need to hand-roll the twice-yearly offset change (the "honestly disclosed
--   simplification" `isUsMarketOpen` already favours over a brittle one).
--   15:00/17:00/19:00 UTC sits squarely inside that overlap year-round, and
--   skipping weekends outright (`1-5`) drops runs that could never do
--   anything but log "markets closed" anyway.
--
--   Net effect: every single scan can now actually act on what it finds —
--   and a missed buy candidate reappears on the very next run at most ~2h
--   later (always same trading day), instead of potentially many hours, or an
--   entire closed weekend, away. See the buy-check's comment in
--   market-scan/index.ts for why that "it just reappears soon" approach beats
--   queuing orders to fill at the next open: a multi-day-stale signal filled
--   at a much-later price would be exactly the kind of noise this schedule
--   change avoids by making "soon" actually mean soon.
--
--   (`HISTORY_LOOKBACK` in market-scan/index.ts was lowered from 28 to 15 to
--   match — at 3 scans × 5 trading days/week, 15 rows is the new "~1 week of
--   samples", preserving the original baseline-horizon intent rather than
--   silently drifting to ~1.9 weeks as a side effect of this change.)
--
-- To inspect or remove the schedule later:
--      select * from cron.job;
--      select cron.unschedule('market-scan-during-trading-hours');

-- ── Cron #2: keep the portfolio value current between full scans ─────────
-- `market-scan` only runs every 6h and does the expensive discovery work.
-- `price-refresh` is a small companion function that just re-prices OPEN
-- positions, fires take-profit/stop-loss exits early if triggered, and writes
-- a fresh `balance_history` snapshot — so the dashboard reflects the
-- portfolio's current value continuously, not just every 6 hours. It reuses
-- the SAME Vault secrets (`service_role_key`); only the URL differs.
--
-- Both functions check real US-exchange trading hours (NYSE/NASDAQ, Mon-Fri
-- 09:30-16:00 America/New_York) before doing anything that resembles placing
-- an order — a real Swissquote account couldn't fill a US-equity trade outside
-- that window either. `price-refresh` simply no-ops (cheap early return, no
-- Yahoo Finance calls, no snapshot write) for the ~17h/day + weekends the
-- market is closed, so scheduling it every 30 minutes round the clock is fine
-- — most of those invocations cost essentially nothing.
--
-- 1. Deploy it once: supabase functions deploy price-refresh
--
-- 2. Schedule it to run every 30 minutes (adjust to taste — see README for
--    the trade-offs of a tighter interval):
--
--      select cron.schedule(
--        'price-refresh-every-30min',
--        '*/30 * * * *',
--        $$
--        select net.http_post(
--          url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/price-refresh',
--          headers := jsonb_build_object(
--            'Content-Type',  'application/json',
--            'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
--          ),
--          body    := '{}'::jsonb
--        );
--        $$
--      );
--
-- To inspect or remove this schedule later:
--      select * from cron.job;
--      select cron.unschedule('price-refresh-every-30min');
