-- ─────────────────────────────────────────────────────────────────────────────
-- Migration v13: Add market-open scan at 14:30 UTC (Mon–Fri)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Adds a fourth pg_cron job that fires at NYSE/NASDAQ market open:
--
--   EDT (UTC−4, Mar–Nov): 14:30 UTC = 10:30 ET  — 1h after bell, post-gap clarity
--   EST (UTC−5, Nov–Mar): 14:30 UTC = 09:30 ET  — exactly at open
--
--   14:30 UTC is the earliest time guaranteed to be at-or-after market open
--   year-round regardless of which side of the DST switch we are on.
--
-- Previously: 3 scans/day at 15:00, 17:00, 19:00 UTC (job: market-scan-during-trading-hours)
-- After this:  4 scans/day at 14:30, 15:00, 17:00, 19:00 UTC
--
-- HISTORY_LOOKBACK in market-scan/index.ts was raised from 15 → 20 to match:
--   4 scans × 5 trading days = 20 rows ≈ 1 trading week of baseline samples.
--
-- Run once in the Supabase SQL editor (or via: npx supabase db query --linked --file <this file>)

select cron.schedule(
  'market-scan-at-open',
  '30 14 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://jbegpqcyzymbwwntbtuk.supabase.co/functions/v1/market-scan',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- Verify all active jobs afterwards:
-- select jobname, schedule, active from cron.job order by jobid;
