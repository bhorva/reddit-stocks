-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query).
-- It creates a simple `stocks` table and enables Row Level Security (RLS).

create table if not exists public.stocks (
  id          bigint generated always as identity primary key,
  ticker      text        not null,
  mentions    integer     not null default 0,
  created_at  timestamptz not null default now()
);

-- Enable Row Level Security. With RLS on and the policies below, the public
-- "anon" key can read and insert rows, but cannot update or delete them.
alter table public.stocks enable row level security;

-- Allow anyone (anon key) to read rows.
create policy "Public read access"
  on public.stocks
  for select
  using (true);

-- Allow anyone (anon key) to insert rows.
-- Tighten or remove this if you do not want public writes.
create policy "Public insert access"
  on public.stocks
  for insert
  with check (true);
