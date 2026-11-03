-- pgTAP tests for public.report_summary (SIT-264, PRD US-06, 7.4, 9.7): privileges, range validation, organization-time bucketing
-- at the edges of a range and across a clock change, zero-filling, daily and weekly buckets, event versus current numbers,
-- archived records, tenant isolation and index use.
begin;
select plan(34);
select tests.create_fixtures();

-- Organization A is in New York (clocks go forward on 2026-03-08), B in Tokyo (no DST).
update public.organizations set timezone = 'America/New_York' where id = tests.org_id('a');
update public.organizations set timezone = 'Asia/Tokyo' where id = tests.org_id('b');

-- ---- shape and privileges
select is((select prosecdef from pg_proc where oid = 'public.report_summary(uuid,date,date)'::regprocedure), false, 'SECURITY INVOKER: the caller''s own row level security decides what is counted');
select ok((select provolatile = 's' and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'public.report_summary(uuid,date,date)'::regprocedure), 'STABLE with a pinned empty search_path');
select ok(has_function_privilege('authenticated', 'public.report_summary(uuid,date,date)', 'execute') and not has_function_privilege('anon', 'public.report_summary(uuid,date,date)', 'execute') and not has_function_privilege('public', 'public.report_summary(uuid,date,date)', 'execute'), 'EXECUTE for authenticated only');

-- ---- fixtures
insert into public.customers (id, organization_id, display_name, source, created_at, archived_at) values
  ('c2000000-0000-4000-8000-000000000001', tests.org_id('a'), 'in 1', 'referral', '2026-03-07 05:00:00+00', null),
  ('c2000000-0000-4000-8000-000000000002', tests.org_id('a'), 'in 2', 'referral', '2026-03-09 03:59:59+00', null),
  ('c2000000-0000-4000-8000-000000000003', tests.org_id('a'), 'in 3', 'website', '2026-03-11 03:59:59+00', null),
  ('c2000000-0000-4000-8000-000000000004', tests.org_id('a'), 'before', 'outbound', '2026-03-07 04:59:59+00', null),
  ('c2000000-0000-4000-8000-000000000005', tests.org_id('a'), 'after', 'outbound', '2026-03-11 04:00:00+00', null),
  ('c2000000-0000-4000-8000-000000000006', tests.org_id('a'), 'archived in range', 'other', '2026-03-08 12:00:00+00', now()),
  ('c2000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'B in range', 'website', '2026-03-08 12:00:00+00', null);

insert into public.opportunities (id, organization_id, customer_id, title, stage, amount_cents, probability_percent, created_at, closed_at, lost_reason, archived_at) values
  -- created: local days 7th (in), 8th x2 (23-hour day), 9th, 10th; two just outside; one archived; one in B
  ('d2000000-0000-4000-8000-000000000001', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'out before', 'new', 100, 10, '2026-03-07 04:59:59+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000002', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'day 7', 'new', 100, 10, '2026-03-07 05:00:00+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000003', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'day 8 early', 'new', 100, 10, '2026-03-08 06:59:59+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000004', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'day 8 late', 'new', 100, 10, '2026-03-09 03:59:59+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000005', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'day 9', 'new', 100, 10, '2026-03-09 04:00:00+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000006', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'day 10', 'new', 100, 10, '2026-03-11 03:59:59+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000007', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'out after', 'new', 100, 10, '2026-03-11 04:00:00+00', null, null, null),
  ('d2000000-0000-4000-8000-000000000008', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'archived', 'new', 100, 10, '2026-03-08 12:00:00+00', null, null, now()),
  ('d2000000-0000-4000-8000-000000000009', tests.org_id('b'), 'c2000000-0000-4000-8000-0000000000b1', 'B deal', 'proposal', 900, 50, '2026-03-08 12:00:00+00', null, null, null),
  -- won on the 8th (1000) and twice on the 9th (500, 250); lost on the 10th; one won deal archived
  ('d2000000-0000-4000-8000-00000000000a', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'won 8', 'won', 1000, 100, '2026-02-01 12:00:00+00', '2026-03-08 15:00:00+00', null, null),
  ('d2000000-0000-4000-8000-00000000000b', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'won 9 a', 'won', 500, 100, '2026-02-01 12:00:00+00', '2026-03-09 04:00:00+00', null, null),
  ('d2000000-0000-4000-8000-00000000000c', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'won 9 b', 'won', 250, 100, '2026-02-01 12:00:00+00', '2026-03-10 03:59:59+00', null, null),
  ('d2000000-0000-4000-8000-00000000000d', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'lost 10', 'lost', 7000, 0, '2026-02-01 12:00:00+00', '2026-03-10 20:00:00+00', 'Price', null),
  ('d2000000-0000-4000-8000-00000000000e', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'won archived', 'won', 999, 100, '2026-02-01 12:00:00+00', '2026-03-08 15:00:00+00', null, now()),
  ('d2000000-0000-4000-8000-00000000000f', tests.org_id('a'), 'c2000000-0000-4000-8000-000000000001', 'lost before', 'lost', 5, 0, '2026-02-01 12:00:00+00', '2026-03-07 04:59:59+00', 'Price', null);

select set_config('opsdesk.actor_mode', 'system', true);
insert into public.tasks (organization_id, title, status, completed_at) values
  (tests.org_id('a'), 'done 7 (23:59 6th local: out)', 'done', '2026-03-07 04:59:59+00'),
  (tests.org_id('a'), 'done 8', 'done', '2026-03-08 20:00:00+00'),
  (tests.org_id('a'), 'done 10 a', 'done', '2026-03-10 12:00:00+00'),
  (tests.org_id('a'), 'done 10 b', 'done', '2026-03-11 03:59:59+00'),
  (tests.org_id('a'), 'done after', 'done', '2026-03-11 04:00:00+00'),
  (tests.org_id('a'), 'still open', 'todo', null),
  (tests.org_id('b'), 'B done', 'done', '2026-03-08 12:00:00+00');
insert into public.tasks (organization_id, title, status, completed_at, archived_at) values
  (tests.org_id('a'), 'archived done', 'done', '2026-03-08 12:00:00+00', now());
select set_config('opsdesk.actor_mode', '', true);

-- ---- a daily range across the spring-forward day
select tests.act_as('a_owner');
create temp table r_daily as select public.report_summary(tests.org_id('a'), '2026-03-07', '2026-03-10') as r;
grant select on r_daily to authenticated;
select is((select r - 'buckets' - 'customersBySource' - 'opportunitiesByStage' - 'today' from r_daily), '{"from":"2026-03-07","to":"2026-03-10","days":4,"bucket":"day","timeZone":"America/New_York"}'::jsonb, 'the range, bucket kind and zone come back');
select is(jsonb_array_length((select r -> 'buckets' from r_daily)), 4, 'one bucket per day, both ends included');
select is((select jsonb_agg(b ->> 'start' order by (b ->> 'start')) from r_daily, jsonb_array_elements(r -> 'buckets') b), '["2026-03-07","2026-03-08","2026-03-09","2026-03-10"]'::jsonb, 'the days are consecutive calendar days');
select is((select jsonb_agg((b ->> 'opportunitiesCreated')::int order by b ->> 'start') from r_daily, jsonb_array_elements(r -> 'buckets') b), '[1,2,1,1]'::jsonb, 'created: edges are local midnight, both of the 23-hour day''s events are on the 8th, archived and B rows do not count');
select is((select jsonb_agg((b ->> 'opportunitiesWon')::int order by b ->> 'start') from r_daily, jsonb_array_elements(r -> 'buckets') b), '[0,1,2,0]'::jsonb, 'won: by closed_at in local days');
select is((select jsonb_agg((b ->> 'wonAmountCents')::bigint order by b ->> 'start') from r_daily, jsonb_array_elements(r -> 'buckets') b), '[0,1000,750,0]'::jsonb, 'won amounts add up per day (the archived 999 is not counted)');
select is((select jsonb_agg((b ->> 'opportunitiesLost')::int order by b ->> 'start') from r_daily, jsonb_array_elements(r -> 'buckets') b), '[0,0,0,1]'::jsonb, 'lost: by closed_at, the one just before the range is out');
select is((select jsonb_agg((b ->> 'tasksCompleted')::int order by b ->> 'start') from r_daily, jsonb_array_elements(r -> 'buckets') b), '[0,1,0,2]'::jsonb, 'tasks completed: by completed_at in local days, open, archived and B tasks excluded');
select is((select r -> 'customersBySource' from r_daily), '{"referral":2,"website":1,"outbound":0,"other":0}'::jsonb, 'customers by source: in-range, unarchived, this workspace only, every source present');
select is((select r #> '{opportunitiesByStage,won}' from r_daily), '{"count":3,"amountCents":1750}'::jsonb, 'the stage totals are the CURRENT state: every unarchived won deal, not only those closed in the range');
select is((select r #> '{opportunitiesByStage,new}' from r_daily), '{"count":7,"amountCents":700}'::jsonb, 'new deals: all unarchived, whenever they were created');
select tests.reset();

-- ---- a daily range is not the same as a weekly one: the same events, 36 days
select tests.act_as('a_owner');
create temp table r_weekly as select public.report_summary(tests.org_id('a'), '2026-03-01', '2026-04-05') as r;
grant select on r_weekly to authenticated;
select is((select r ->> 'bucket' from r_weekly), 'week', 'more than 31 days switches to weekly buckets');
select is(jsonb_array_length((select r -> 'buckets' from r_weekly)), 6, '36 days = five 7-day buckets and a one-day last bucket');
select is((select r -> 'buckets' -> 5 ->> 'start' from r_weekly) || '/' || (select r -> 'buckets' -> 5 ->> 'end' from r_weekly), '2026-04-05/2026-04-05', 'the last bucket is clipped to the end of the range');
select is((select jsonb_agg((b ->> 'opportunitiesCreated')::int order by b ->> 'start') from r_weekly, jsonb_array_elements(r -> 'buckets') b), '[2,5,0,0,0,0]'::jsonb, 'weekly created: the 6th and 7th (local) are week one, the 8th to 11th week two, empty weeks are zero');
select is((select sum((b ->> 'tasksCompleted')::int) from r_weekly, jsonb_array_elements(r -> 'buckets') b), 5::bigint, 'weekly tasks completed add up to every in-range completion (the daily range was narrower: 6th to 11th local here)');
select is((select jsonb_agg(b ->> 'start' order by b ->> 'start') from r_weekly, jsonb_array_elements(r -> 'buckets') b), '["2026-03-01","2026-03-08","2026-03-15","2026-03-22","2026-03-29","2026-04-05"]'::jsonb, 'buckets start on the first day of the range, seven days apart');
-- exactly 31 days is still daily, 32 is weekly
select is(public.report_summary(tests.org_id('a'), '2026-03-01', '2026-03-31') ->> 'bucket', 'day', '31 days is daily');
select is(public.report_summary(tests.org_id('a'), '2026-03-01', '2026-04-01') ->> 'bucket', 'week', '32 days is weekly');
-- a one-day range, and an empty range of days
select is(jsonb_array_length(public.report_summary(tests.org_id('a'), '2026-03-08', '2026-03-08') -> 'buckets'), 1, 'a single day is one bucket');
select is((public.report_summary(tests.org_id('a'), '2025-01-01', '2025-01-03') #>> '{buckets,0,opportunitiesCreated}')::int, 0, 'a range with no events is all zeros, still with every bucket');
select tests.reset();

-- ---- invalid ranges
select tests.act_as('a_owner');
select is(tests.sqlstate_of(format($$select public.report_summary(%L, '2026-03-10', '2026-03-09')$$, tests.org_id('a'))), 'OD422', 'an end before the start is refused');
select is(tests.sqlstate_of(format($$select public.report_summary(%L, '2026-01-01', '2027-01-02')$$, tests.org_id('a'))), 'OD422', 'more than 366 days is refused');
select is(tests.sqlstate_of(format($$select public.report_summary(%L, null, '2026-03-09')$$, tests.org_id('a'))), 'OD422', 'a missing start is refused');
select is(jsonb_array_length(public.report_summary(tests.org_id('a'), '2026-01-01', '2027-01-01') -> 'buckets'), 53, 'exactly 366 days is accepted (53 weekly buckets)');
select tests.reset();

-- ---- isolation, roles and the plan
select tests.act_as('b_owner');
select is((public.report_summary(tests.org_id('b'), '2026-03-08', '2026-03-08') #>> '{buckets,0,opportunitiesCreated}')::int, 1, 'B counts only its own deal, in Tokyo''s calendar');
select is(tests.sqlstate_of(format($$select public.report_summary(%L, '2026-03-07', '2026-03-10')$$, tests.org_id('a'))), 'OD404', 'B''s owner asking for A gets the not-found error');
select tests.reset();
select tests.act_as('a_viewer');
select is(jsonb_array_length(public.report_summary(tests.org_id('a'), '2026-03-07', '2026-03-10') -> 'buckets'), 4, 'a viewer can read the reports');
select tests.reset();
select tests.act_as('outsider');
select is(tests.sqlstate_of(format($$select public.report_summary(%L, '2026-03-07', '2026-03-10')$$, tests.org_id('a'))), 'OD404', 'a user with no membership gets not-found');
select tests.reset();
select tests.act_as_anon();
select is(tests.sqlstate_of(format($$select public.report_summary(%L, '2026-03-07', '2026-03-10')$$, tests.org_id('a'))), '42501', 'the anon role cannot call it');
select tests.reset();
select ok((select count(*) = 3 from pg_indexes where schemaname = 'public' and indexname in ('opportunities_org_created_idx', 'opportunities_org_closed_idx', 'tasks_org_completed_idx')), 'the three event-date indexes exist');

select * from finish();
rollback;
