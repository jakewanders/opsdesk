-- SIT-199 (found by its tests): demo_ts(0, 9) is "today at 09:00", which is still in the FUTURE when the database
-- clock is before 09:00, so a seeded record could be dated after now. Clamp to a few minutes ago so seeded
-- history is always in the past. Offsets of one day or more are unaffected.
create or replace function private.demo_ts(days_ago integer, at_hour integer default 9)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select least(
    pg_catalog.date_trunc('day', pg_catalog.now()) - pg_catalog.make_interval(days => days_ago) + pg_catalog.make_interval(hours => at_hour),
    pg_catalog.now() - interval '5 minutes'
  )
$$;
