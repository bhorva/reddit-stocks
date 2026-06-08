-- Migration v8 — run this in the Supabase SQL editor AFTER
-- trading_schema_v7_etf_flag.sql has been applied. Purely a permissions
-- change (DROP/CREATE POLICY + REVOKE/GRANT) — touches no table structure or
-- data, and is safe to re-run.
--
-- WHY: the dashboard now sits behind a login (a single user, "bhorvath" —
-- see `auth.service.ts` / `login.component.ts` / `setup-auth-user` Edge
-- Function). That UI lock is only a MEANINGFUL gate if the data itself also
-- requires authentication: this app is a public SPA shipping a public
-- `anon` key in `public/config.js`, so a UI-only check is a curtain in front
-- of an open door — anyone could still read every table directly via the
-- PostgREST REST API with that same key, exactly like before this migration.
--
-- Until now every table here used "public read" RLS (`using (true)`,
-- granting `anon` unrestricted SELECT) quite deliberately — the dashboard was
-- meant to be an open, shareable view of the simulation. That has now
-- changed: the data is to live behind the login, so every one of those
-- policies is replaced with an "authenticated read" version
-- (`using (auth.role() = 'authenticated')`) — a valid Supabase Auth session
-- is now required to read ANY row.
--
-- No insert/update/delete policies existed for `anon`/`authenticated` before,
-- and still don't: only the service-role key (used by the `market-scan` /
-- `price-refresh` Edge Functions, which bypasses RLS entirely) can write —
-- completely unaffected by this migration.

drop policy if exists "Public read access" on public.watchlist;
drop policy if exists "Public read access" on public.signals;
drop policy if exists "Public read access" on public.portfolio;
drop policy if exists "Public read access" on public.positions;
drop policy if exists "Public read access" on public.transactions;
drop policy if exists "Public read access" on public.balance_history;

-- Idempotency for re-runs after this migration has already landed once.
drop policy if exists "Authenticated read access" on public.watchlist;
drop policy if exists "Authenticated read access" on public.signals;
drop policy if exists "Authenticated read access" on public.portfolio;
drop policy if exists "Authenticated read access" on public.positions;
drop policy if exists "Authenticated read access" on public.transactions;
drop policy if exists "Authenticated read access" on public.balance_history;

create policy "Authenticated read access" on public.watchlist       for select using (auth.role() = 'authenticated');
create policy "Authenticated read access" on public.signals         for select using (auth.role() = 'authenticated');
create policy "Authenticated read access" on public.portfolio       for select using (auth.role() = 'authenticated');
create policy "Authenticated read access" on public.positions       for select using (auth.role() = 'authenticated');
create policy "Authenticated read access" on public.transactions    for select using (auth.role() = 'authenticated');
create policy "Authenticated read access" on public.balance_history for select using (auth.role() = 'authenticated');

-- ── Performance views (v3) ───────────────────────────────────────────────
-- `trade_outcomes_by_verdict`/`trade_outcomes_by_zscore_bucket` are views
-- owned by the table owner — by default they run with THAT role's privileges
-- (not the querying role's), so table-level RLS alone does not gate them; the
-- v3 migration had to GRANT SELECT to `anon` explicitly for PostgREST to
-- expose them at all, and that grant is what actually controlled their
-- visibility. Revoking it from `anon` here closes the same gap for these
-- views that the policy changes above close for the underlying tables —
-- otherwise they'd remain a side door into aggregated trade data even after
-- every table is locked down.
revoke select on public.trade_outcomes_by_verdict       from anon;
revoke select on public.trade_outcomes_by_zscore_bucket from anon;
grant  select on public.trade_outcomes_by_verdict       to authenticated;
grant  select on public.trade_outcomes_by_zscore_bucket to authenticated;
