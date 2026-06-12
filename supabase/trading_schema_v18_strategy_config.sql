-- v18 — Single source of truth for the strategy constants
-- ===================================================================
-- Why
-- ---
-- The tuning knobs (take-profit, stops, dip thresholds, position sizing, …)
-- lived as hand-duplicated constants in THREE places: market-scan,
-- price-refresh and the Angular dashboard — "kept in sync" only by comments.
-- Drift had already happened once (the dashboard still described the old
-- ~6.3%/47% pre-hard-stop fee math). This singleton table makes the values
-- correct by construction: both Edge Functions load it at the start of every
-- run, the dashboard reads it for its labels/exit-bar — and a threshold can
-- be tuned with a single UPDATE, no redeploys.
--
-- Fallback: every reader keeps its current hard-coded values as defaults, so
-- nothing breaks while this migration is pending (or if the read fails).
--
-- Apply once in the Supabase SQL editor.

create table if not exists public.strategy_config (
  -- Singleton pattern, same as `portfolio`: a bool PK that must be true.
  id boolean primary key default true check (id),

  take_profit                    numeric not null default 0.20,  -- unconditional take-profit, % gain from entry
  stop_loss                      numeric not null default -0.06, -- trailing-stop DISTANCE below the since-entry peak
  hard_stop                      numeric not null default -0.08, -- unconditional capital floor, % loss from entry
  dip_thresh                     numeric not null default -0.04, -- buy once price has dropped this much from its multi-week high
  near_dip_buffer                numeric not null default 0.01,  -- pp above dip_thresh that still qualifies (with streak confirmation)
  consecutive_organic_threshold  integer not null default 2,     -- prior organic scans required for a near-miss buy
  position_size                  numeric not null default 0.24,  -- fraction of total portfolio value per buy
  max_positions                  integer not null default 3,     -- open-position slots
  hype_block_thr                 numeric not null default 65,    -- hype score above which a ticker can be blocked
  round_trip_fee_pct             numeric not null default 0.044, -- display-only: approx. round-trip cost (dashboard break-even line)

  updated_at timestamptz not null default now()
);

insert into public.strategy_config (id) values (true)
on conflict (id) do nothing;

-- Same access model as the other trading tables since v8: only authenticated
-- sessions read; only the service role (Edge Functions / SQL editor) writes.
alter table public.strategy_config enable row level security;
drop policy if exists "Authenticated read access" on public.strategy_config;
create policy "Authenticated read access" on public.strategy_config
  for select using (auth.role() = 'authenticated');
