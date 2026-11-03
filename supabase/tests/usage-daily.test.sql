-- pgTAP tests for the first-party daily usage counts (P-03, SIT-146): isolation, correctness against a fixture with known
-- actions, idempotency, the three places a demo is counted (cleanup, bootstrap replacing an expired demo, reset), and that the
-- rollup holds counts only. Uses the shared helpers in 000-test-helpers.test.sql.
begin;
select plan(51);
select tests.create_fixtures();

-- ---- isolation: no browser role can read or write the tables or call the functions
select is((select count(*) from unnest(array['private.usage_daily', 'private.demo_usage']) t
            where has_table_privilege('anon', t, 'select,insert,update,delete') or has_table_privilege('authenticated', t, 'select,insert,update,delete')
               or has_any_column_privilege('anon', t, 'select,insert,update') or has_any_column_privilege('authenticated', t, 'select,insert,update')),
  0::bigint, 'anon and authenticated hold no privilege on the usage tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'private' and c.relname in ('usage_daily', 'demo_usage') and c.relrowsecurity), 2::bigint, 'row level security is on for both usage tables');
select is((select count(*) from pg_policies where schemaname = 'private' and tablename in ('usage_daily', 'demo_usage')), 0::bigint, 'and neither has a policy (closed to every non-bypass role)');
select is((select count(*) from unnest(array['private.demo_usage_flags(uuid)', 'private.usage_capture_demo(uuid, boolean)', 'private.usage_rollup_demo(uuid)', 'public.usage_report(integer)']) f
            where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') or has_function_privilege('public', f, 'execute') or not has_function_privilege('service_role', f, 'execute')),
  0::bigint, 'every usage function is executable by service_role and by no browser role');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and p.proname in ('demo_usage_flags', 'usage_capture_demo', 'usage_rollup_demo', 'usage_report')
              and not (p.prosecdef and coalesce(p.proconfig, '{}') @> array['search_path=""'])), 0::bigint, 'all of them are SECURITY DEFINER with an empty search_path');
select tests.act_as('g1');
select ok(tests.denied($$select private.usage_rollup_demo(tests.org_id('g1'))$$), 'a guest cannot run the rollup');
select ok(tests.denied($$select public.usage_report(30)$$), 'a guest cannot read the report');
select ok(tests.denied($$select * from private.usage_daily$$), 'a guest cannot read the counters');
select ok(tests.denied($$insert into private.usage_daily (day, metric, total) values (current_date, 'demos_started', 999)$$), 'a guest cannot write the counters');
select tests.reset();
select tests.act_as('a_owner');
select ok(tests.denied($$select private.usage_rollup_demo(tests.org_id('a'))$$), 'a real user cannot run the rollup');
select ok(tests.denied($$select public.usage_report(30)$$), 'a real user cannot read the report');
select ok(tests.denied($$delete from private.usage_daily$$), 'a real user cannot delete counters');
select tests.reset();
select tests.act_as_anon();
select ok(tests.denied($$select public.usage_report(30)$$), 'the anon key cannot read the report');
select tests.reset();

-- ---- what the rollup stores: counts only
select is((select string_agg(column_name || ':' || data_type, ', ' order by ordinal_position) from information_schema.columns where table_schema = 'private' and table_name = 'usage_daily'),
  'day:date, metric:text, total:bigint', 'the counters hold a day, a metric name and a count: no id, no name, no finer timestamp');
select is((select string_agg(column_name, ', ' order by ordinal_position) from information_schema.columns
            where table_schema = 'private' and table_name = 'demo_usage' and data_type <> 'boolean'), 'organization_id', 'the per-demo scratch table holds booleans and the organization key only (it is deleted with the demo)');
select is(pg_get_function_result('public.usage_report(integer)'::regprocedure), 'TABLE(day date, metric text, total bigint)', 'the report returns day, metric, total only');

-- ---- fixture: four demos created on the same past UTC day. g1 acts, g2 acts then resets, g3 (expired) did nothing, e1 (expired) holds seed data only
set constraints all immediate;
set constraints all deferred;
alter table public.organizations disable trigger organizations_protect_columns;
insert into auth.users (id, email, is_anonymous) values ('e1000000-0000-4000-8000-000000000001', null, true);
insert into public.organizations (id, name, kind, expires_at, created_by) values
  ('e1000000-0000-4000-8000-0000000000d1', 'Expired seed only', 'demo', now() + interval '1 hour', 'e1000000-0000-4000-8000-000000000001');
insert into public.memberships (organization_id, user_id, role) values ('e1000000-0000-4000-8000-0000000000d1', 'e1000000-0000-4000-8000-000000000001', 'owner');
select private.register_demo_workspace('e1000000-0000-4000-8000-0000000000d1', 'e1000000-0000-4000-8000-000000000001');
update public.organizations set created_at = timestamptz '2026-01-15 23:30:00+00'
 where id in (tests.org_id('g1'), tests.org_id('g2'), tests.org_id('expired'), 'e1000000-0000-4000-8000-0000000000d1');
set constraints all immediate;
set constraints all deferred;
alter table public.organizations enable trigger organizations_protect_columns;
select private.set_demo_expiry(tests.org_id('expired'), now() - interval '10 minutes');
select private.set_demo_expiry('e1000000-0000-4000-8000-0000000000d1', now() - interval '5 minutes');
select private.seed_demo_workspace(tests.org_id('g1'));
select private.seed_demo_workspace(tests.org_id('g2'));
select private.seed_demo_workspace('e1000000-0000-4000-8000-0000000000d1');

-- the seed is full of customers, deals, completed tasks and quotes, and none of it counts
select ok((select count(*) from public.activity_events where organization_id = tests.org_id('g1')) > 40, 'the seeded demo has plenty of history');
select is((select string_agg(f::text, ',') from private.demo_usage_flags(tests.org_id('g1')) f), '(f,f,f,f,f,f)', 'a freshly seeded demo has no visitor action: the seed (written by the System) is never counted');
select is((select string_agg(f::text, ',') from private.demo_usage_flags('e1000000-0000-4000-8000-0000000000d1') f), '(f,f,f,f,f,f)', 'nor does an expired demo holding only seed data');

-- g1: a customer, a deal moved a stage, a task completed, a quote created
select tests.act_as('g1');
insert into public.customers (id, organization_id, display_name) values ('c0000000-0000-4000-8000-0000000000a1', tests.org_id('g1'), 'Usage test customer');
insert into public.opportunities (id, organization_id, customer_id, title) values ('d0000000-0000-4000-8000-0000000000a1', tests.org_id('g1'), 'c0000000-0000-4000-8000-0000000000a1', 'Usage test deal');
select is((select count(*) from public.move_opportunity_stage('d0000000-0000-4000-8000-0000000000a1', 'qualified', null, (select updated_at from public.opportunities where id = 'd0000000-0000-4000-8000-0000000000a1')) r), 1::bigint, 'g1 moves a deal');
insert into public.tasks (id, organization_id, title) values ('e0000000-0000-4000-8000-0000000000a1', tests.org_id('g1'), 'Usage test task');
update public.tasks set status = 'done' where id = 'e0000000-0000-4000-8000-0000000000a1';
select is((select count(*) from public.create_quote_with_items(tests.org_id('g1'), 'c0000000-0000-4000-8000-0000000000a1', null, 'Usage quote', null, null, 0, 0, null,
  '[{"description":"Line","quantity":1,"unitPriceCents":100}]'::jsonb) q), 1::bigint, 'g1 creates a quote');
select tests.reset();
select is((select string_agg(f::text, ',') from private.demo_usage_flags(tests.org_id('g1')) f), '(t,t,t,t,t,f)', 'g1: customer, stage move, task, quote, any action; not reset');

-- g2: a customer, then a reset. The reset clears the visitor's rows, but what they did before it still counts
select tests.act_as('g2');
insert into public.customers (organization_id, display_name) values (tests.org_id('g2'), 'Usage test customer 2');
select tests.reset();
select is((select string_agg(f::text, ',') from private.demo_usage_flags(tests.org_id('g2')) f), '(t,f,f,f,t,f)', 'g2: a customer');
select tests.act_as('g2');
select lives_ok($$select public.reset_demo_workspace(tests.org_id('g2'))$$, 'g2 resets the demo');
select tests.reset();
select is((select count(*) from public.customers where organization_id = tests.org_id('g2') and display_name = 'Usage test customer 2'), 0::bigint, 'the reset removed the visitor''s customer');
select is((select string_agg(f::text, ',') from private.demo_usage_flags(tests.org_id('g2')) f), '(t,f,f,f,t,t)', 'but the customer still counts, and the demo is marked as reset');

-- ---- the rollup: once per demo
select is(private.usage_rollup_demo(tests.org_id('g1')), true, 'the rollup counts g1');
select is(private.usage_rollup_demo(tests.org_id('g1')), false, 'a second call counts nothing (idempotent)');
select is(private.usage_rollup_demo('00000000-0000-4000-8000-0000000000ff'), false, 'an unknown organization is a no-op');
select throws_ok($$select private.usage_rollup_demo(tests.org_id('a'))$$, 'OD403', 'Only demo workspaces have usage counts.', 'a real organization is refused');
select throws_ok($$select private.usage_capture_demo(tests.org_id('a'))$$, 'OD403', null, 'and cannot be captured');
select is((select total from private.usage_daily where day = date '2026-01-15' and metric = 'demos_started'), 1::bigint, 'one demo started that day so far');

-- g3 (expired, untouched) goes through the bootstrap that replaces an expired demo; the rest through the cleanup
select tests.act_as('g3');
select is((select (public.bootstrap_demo_workspace()->>'created')::boolean), true, 'g3 starts a fresh demo (their expired one is replaced)');
select tests.reset();
select is((select total from private.usage_daily where day = date '2026-01-15' and metric = 'demos_started'), 2::bigint, 'the replaced demo was counted before it was deleted');
select is((select total from private.usage_daily where day = date '2026-01-15' and metric = 'demos_expired_unused'), 1::bigint, 'as unused');
select is((select count(*) from public.organizations where id = tests.org_id('expired')), 0::bigint, 'and it is gone');

select private.set_demo_expiry(tests.org_id('g1'), now() - interval '3 minutes');
select private.set_demo_expiry(tests.org_id('g2'), now() - interval '2 minutes');
select ok((public.cleanup_purge_expired_demos(100)->>'orgs_deleted')::int >= 3, 'the cleanup deletes the expired demos');
select is((select count(*) from public.organizations where id in (tests.org_id('g1'), tests.org_id('g2'), 'e1000000-0000-4000-8000-0000000000d1')), 0::bigint, 'g1, g2 and e1 are gone');
select is((select count(*) from private.demo_usage where organization_id in (tests.org_id('g1'), tests.org_id('g2'), 'e1000000-0000-4000-8000-0000000000d1')), 0::bigint, 'their scratch rows went with them: no organization id survives anywhere');

select is((select string_agg(metric || '=' || total, ', ' order by metric) from private.usage_daily where day = date '2026-01-15'),
  'demos_expired_unused=2, demos_reset=1, demos_started=4, demos_with_customer_created=2, demos_with_quote_created=1, demos_with_stage_move=1, demos_with_task_completed=1',
  'the day''s counts are exactly what the fixture did: 4 started, 2 customers, 1 stage move, 1 task, 1 quote, 1 reset, 2 unused (g3 and the seed-only demo)');
select is((select count(*) from private.usage_daily where day <> date '2026-01-15' and total > 0 and day < current_date - 1), 0::bigint, 'no other past day was touched');

-- running the cleanup again changes nothing
create temp table before_second as select day, metric, total from private.usage_daily;
select public.cleanup_purge_expired_demos(100);
select is((select count(*) from (select day, metric, total from private.usage_daily except select day, metric, total from before_second) d), 0::bigint, 'a second cleanup does not change any count');

-- ---- the report: rolled-up days plus demos still alive today (live)
select is((select total from public.usage_report(400) where day = date '2026-01-15' and metric = 'demos_started'), 4::bigint, 'the report shows the rolled-up day');
select is((select total from public.usage_report(400) where day = date '2026-01-15' and metric = 'demos_with_quote_created'), 1::bigint, 'and its feature counts');
select is((select count(*) from public.usage_report(30) where day = date '2026-01-15'), 0::bigint, 'a 30-day report leaves older days out');
select throws_ok($$select public.usage_report(0)$$, 'P0001', 'days must be between 1 and 400', 'the window is bounded');
-- g3's new demo (created today, still alive) is counted live, as in progress, and not rolled up
select is((select total from public.usage_report(30) where day = (now() at time zone 'utc')::date and metric = 'demos_in_progress'),
  (select count(*) from public.organizations o where o.kind = 'demo' and o.expires_at > now() and (o.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date),
  'demos still alive are computed live and marked in progress');
select is((select count(*) from private.demo_usage u join public.demo_workspaces w on w.organization_id = u.organization_id where w.user_id = tests.uid('g3') and u.rolled_up), 0::bigint, 'and a live demo is not rolled up into the counters yet');
select tests.act_as('g3');
insert into public.customers (organization_id, display_name) values ((select organization_id from public.demo_workspaces where user_id = tests.uid('g3')), 'Live customer');
select tests.reset();
select is((select total from public.usage_report(30) where day = (now() at time zone 'utc')::date and metric = 'demos_with_customer_created'),
  (select count(distinct e.organization_id) from public.activity_events e join public.organizations o on o.id = e.organization_id
    where o.kind = 'demo' and e.actor_user_id is not null and e.entity_type = 'customer' and e.action = 'created' and (o.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date
      and not exists (select 1 from private.demo_usage u where u.organization_id = o.id and u.rolled_up))
    + coalesce((select total from private.usage_daily where day = (now() at time zone 'utc')::date and metric = 'demos_with_customer_created'), 0),
  'a live demo''s customer shows up in today''s numbers (live demos plus what earlier demos of the day already rolled up)');
select is((select coalesce(sum(total), 0)::bigint from public.usage_report(30) where metric = 'demos_expired_unused' and day = (now() at time zone 'utc')::date),
  coalesce((select total from private.usage_daily where day = (now() at time zone 'utc')::date and metric = 'demos_expired_unused'), 0)::bigint,
  'a running demo is never called unused: only demos that expired and were counted are');

-- ---- retention: the cleanup purges counter rows older than 400 days
insert into private.usage_daily (day, metric, total) values (current_date - 401, 'demos_started', 5), (current_date - 399, 'demos_started', 6);
select public.cleanup_purge_expired_demos(1);
select is((select string_agg(total::text, ',' order by day) from private.usage_daily where day in (current_date - 401, current_date - 399)), '6', 'rows older than 400 days are purged, newer ones kept');

select * from finish();
rollback;
