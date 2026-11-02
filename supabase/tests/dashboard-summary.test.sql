-- pgTAP tests for public.dashboard_summary (SIT-244, PRD US-06): shape, exact arithmetic, the organization-time rules
-- (checked in two zones 25 hours apart), tenant isolation and that changes show up in the next answer.
begin;
select plan(30);
select tests.create_fixtures();

-- Two zones with fixed offsets and no DST: Kiritimati is UTC+14, Pago Pago is UTC-11.
update public.organizations set timezone = 'Pacific/Kiritimati' where id = tests.org_id('a');
update public.organizations set timezone = 'Pacific/Pago_Pago' where id = tests.org_id('b');

-- ---- shape and privileges
select is((select prosecdef from pg_proc where oid = 'public.dashboard_summary(uuid)'::regprocedure), false, 'SECURITY INVOKER: the caller''s own row level security decides what is counted');
select ok((select provolatile = 's' and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'public.dashboard_summary(uuid)'::regprocedure), 'STABLE with a pinned empty search_path');
select ok(has_function_privilege('authenticated', 'public.dashboard_summary(uuid)', 'execute') and not has_function_privilege('anon', 'public.dashboard_summary(uuid)', 'execute') and not has_function_privilege('public', 'public.dashboard_summary(uuid)', 'execute'), 'EXECUTE for authenticated only');

-- ---- an empty workspace
select tests.act_as('a_owner');
select is(public.dashboard_summary(tests.org_id('a')) - 'today' - 'timeZone', '{"activeCustomers":0,"openOpportunities":0,"pipelineCents":0,"weightedPipelineCents":0,"overdueTasks":0,"tasksDueNext7Days":0,"opportunitiesByStage":{"new":{"count":0,"amountCents":0},"qualified":{"count":0,"amountCents":0},"proposal":{"count":0,"amountCents":0},"negotiation":{"count":0,"amountCents":0},"won":{"count":0,"amountCents":0},"lost":{"count":0,"amountCents":0}}}'::jsonb, 'an empty workspace is all zeros, with every stage present');
select tests.reset();

-- ---- data: the same shape in both workspaces
insert into public.customers (id, organization_id, display_name, archived_at) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'A active 1', null),
  ('c1000000-0000-4000-8000-0000000000a2', tests.org_id('a'), 'A active 2', null),
  ('c1000000-0000-4000-8000-0000000000a3', tests.org_id('a'), 'A archived', now()),
  ('c1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'B active 1', null);
insert into public.opportunities (id, organization_id, customer_id, title, stage, amount_cents, probability_percent, archived_at, closed_at, lost_reason) values
  ('d1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'half a cent', 'proposal', 1, 50, null, null, null),        -- 0.5 -> 1
  ('d1000000-0000-4000-8000-000000000002', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'one and a half', 'proposal', 3, 50, null, null, null),     -- 1.5 -> 2
  ('d1000000-0000-4000-8000-000000000003', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a2', 'under a half', 'qualified', 1, 49, null, null, null),      -- 0.49 -> 0
  ('d1000000-0000-4000-8000-000000000004', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a2', 'big', 'negotiation', 123456789, 75, null, null, null),     -- 92592591.75 -> 92592592
  ('d1000000-0000-4000-8000-000000000005', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a2', 'new one', 'new', 1000, 10, null, null, null),             -- 100
  ('d1000000-0000-4000-8000-000000000006', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'won deal', 'won', 5000, 100, null, now(), null),
  ('d1000000-0000-4000-8000-000000000007', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'lost deal', 'lost', 7000, 0, null, now(), 'Price'),
  ('d1000000-0000-4000-8000-000000000008', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'archived open', 'proposal', 999999, 50, now(), null, null),
  ('d1000000-0000-4000-8000-000000000009', tests.org_id('b'), 'c1000000-0000-4000-8000-0000000000b1', 'B deal', 'proposal', 777000, 50, null, null, null);

-- tasks: due dates are offsets from the UTC date, so the two zones (UTC+14 and UTC-11) see different "today"s
insert into public.tasks (organization_id, title, status, due_date)
select o, 'T' || d || '/' || st, st, (now() at time zone 'utc')::date + d
  from (values (tests.org_id('a')), (tests.org_id('b'))) as orgs(o),
       generate_series(-3, 9) as d,
       (values ('todo'), ('in_progress'), ('done')) as s(st);
insert into public.tasks (organization_id, title, status, due_date) values
  (tests.org_id('a'), 'no date', 'todo', null),
  (tests.org_id('b'), 'no date', 'todo', null);
insert into public.tasks (organization_id, title, status, due_date, archived_at) values
  (tests.org_id('a'), 'archived overdue', 'todo', (now() at time zone 'utc')::date - 5, now());

-- ---- customers and pipeline arithmetic (organization A)
select tests.act_as('a_owner');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'activeCustomers')::int, 2, 'activeCustomers counts unarchived customers only');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'openOpportunities')::int, 5, 'openOpportunities counts the four open stages, not won, lost or archived');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'pipelineCents')::bigint, 1::bigint + 3 + 1 + 123456789 + 1000, 'pipelineCents sums open, unarchived amounts only');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'weightedPipelineCents')::bigint, 1::bigint + 2 + 0 + 92592592 + 100, 'weightedPipelineCents rounds each deal half up, then sums (1 + 2 + 0 + 92592592 + 100)');
select is(public.dashboard_summary(tests.org_id('a')) #> '{opportunitiesByStage,won}', '{"count":1,"amountCents":5000}'::jsonb, 'won is counted by stage with its amount');
select is(public.dashboard_summary(tests.org_id('a')) #> '{opportunitiesByStage,proposal}', '{"count":2,"amountCents":4}'::jsonb, 'the archived proposal is not in the by-stage numbers');
select is((select count(*) from jsonb_object_keys(public.dashboard_summary(tests.org_id('a')) -> 'opportunitiesByStage')), 6::bigint, 'all six stages are present');

-- ---- the organization-time rule, in two zones, against an independent computation (the zone's fixed UTC offset)
select is(public.dashboard_summary(tests.org_id('a')) ->> 'timeZone', 'Pacific/Kiritimati', 'the zone is the organization''s');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'today')::date, (now() + interval '14 hours')::date, 'Kiritimati''s today is the date at UTC+14');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'overdueTasks')::int,
  (select count(*)::int from public.tasks t where t.organization_id = tests.org_id('a') and t.archived_at is null and t.status <> 'done' and t.due_date < (now() + interval '14 hours')::date),
  'overdueTasks in Kiritimati = not done and due before its local today (archived and done excluded, due today excluded)');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'tasksDueNext7Days')::int,
  (select count(*)::int from public.tasks t where t.organization_id = tests.org_id('a') and t.archived_at is null and t.status <> 'done' and t.due_date between (now() + interval '14 hours')::date and (now() + interval '14 hours')::date + 7),
  'tasksDueNext7Days in Kiritimati = from its local today through today + 7');
select tests.reset();
select tests.act_as('b_owner');
select is((public.dashboard_summary(tests.org_id('b')) ->> 'today')::date, (now() - interval '11 hours')::date, 'Pago Pago''s today is the date at UTC-11');
select is((public.dashboard_summary(tests.org_id('b')) ->> 'overdueTasks')::int,
  (select count(*)::int from public.tasks t where t.organization_id = tests.org_id('b') and t.status <> 'done' and t.due_date < (now() - interval '11 hours')::date),
  'overdueTasks in Pago Pago uses ITS today');
select is((public.dashboard_summary(tests.org_id('b')) ->> 'tasksDueNext7Days')::int,
  (select count(*)::int from public.tasks t where t.organization_id = tests.org_id('b') and t.status <> 'done' and t.due_date between (now() - interval '11 hours')::date and (now() - interval '11 hours')::date + 7),
  'tasksDueNext7Days in Pago Pago uses ITS today');
select tests.reset();
-- the same instant gives the two zones different answers (they are 25 hours apart)
select tests.act_as('a_owner');
create temp table zone_a as select (public.dashboard_summary(tests.org_id('a')) ->> 'overdueTasks')::int as overdue;
select tests.reset();
select tests.act_as('b_owner');
create temp table zone_b as select (public.dashboard_summary(tests.org_id('b')) ->> 'overdueTasks')::int as overdue;
select tests.reset();
select cmp_ok((select overdue from zone_a), '>', (select overdue from zone_b), 'the zone ahead of UTC has more overdue tasks than the zone behind it for the same instant');

-- ---- isolation
select tests.act_as('b_owner');
select is((public.dashboard_summary(tests.org_id('b')) ->> 'activeCustomers')::int, 1, 'B sees only its own customer');
select is((public.dashboard_summary(tests.org_id('b')) ->> 'pipelineCents')::bigint, 777000::bigint, 'B''s pipeline is only B''s deal');
select is(tests.sqlstate_of(format($$select public.dashboard_summary(%L)$$, tests.org_id('a'))), 'OD404', 'B''s owner asking for A gets the not-found error');
select tests.reset();
select tests.act_as('outsider');
select is(tests.sqlstate_of(format($$select public.dashboard_summary(%L)$$, tests.org_id('a'))), 'OD404', 'a user with no membership gets the same error');
select is(tests.sqlstate_of($$select public.dashboard_summary('00000000-0000-4000-8000-000000000000')$$), 'OD404', 'and so does an unknown workspace id');
select tests.reset();
select tests.act_as('a_viewer');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'activeCustomers')::int, 2, 'a viewer can read the dashboard');
select tests.reset();
select tests.act_as_anon();
select is(tests.sqlstate_of(format($$select public.dashboard_summary(%L)$$, tests.org_id('a'))), '42501', 'the anon role cannot call it');
select tests.reset();

-- ---- changes show up in the next answer
select tests.act_as('a_owner');
create temp table before_change as select public.dashboard_summary(tests.org_id('a')) as s;
grant select on before_change to authenticated;
update public.opportunities set stage = 'won', closed_at = now() where id = 'd1000000-0000-4000-8000-000000000004';
select is((public.dashboard_summary(tests.org_id('a')) ->> 'pipelineCents')::bigint, ((select s ->> 'pipelineCents' from before_change)::bigint - 123456789), 'moving a deal to Won lowers the open pipeline by its amount');
select is((public.dashboard_summary(tests.org_id('a')) ->> 'weightedPipelineCents')::bigint, ((select s ->> 'weightedPipelineCents' from before_change)::bigint - 92592592), 'and the weighted pipeline by its weighted amount');
update public.tasks set status = 'done' where organization_id = tests.org_id('a') and title like 'T-3/todo';
select is((public.dashboard_summary(tests.org_id('a')) ->> 'overdueTasks')::int, ((select s ->> 'overdueTasks' from before_change)::int - 1), 'completing an overdue task lowers overdueTasks by one');
update public.customers set archived_at = now() where id = 'c1000000-0000-4000-8000-0000000000a1';
select is((public.dashboard_summary(tests.org_id('a')) ->> 'activeCustomers')::int, 1, 'archiving a customer lowers activeCustomers');
select tests.reset();

select * from finish();
rollback;
