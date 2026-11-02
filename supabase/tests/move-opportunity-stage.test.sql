-- pgTAP tests for public.move_opportunity_stage (SIT-227, PRD US-04, 6.5, 7.4).
begin;
select plan(32);
select tests.create_fixtures();
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer'),
  ('c1000000-0000-4000-8000-0000000000d1', tests.org_id('g1'), 'Demo Customer');

-- ---- surface
select is((select prosecdef from pg_proc where oid = 'public.move_opportunity_stage(uuid,text,text,timestamptz)'::regprocedure), false, 'the RPC runs as the caller (SECURITY INVOKER): row level security decides');
select is(has_function_privilege('anon', 'public.move_opportunity_stage(uuid,text,text,timestamptz)', 'execute'), false, 'anon cannot call it');
select is(has_function_privilege('authenticated', 'public.move_opportunity_stage(uuid,text,text,timestamptz)', 'execute'), true, 'a signed-in user can');
select is((select proconfig from pg_proc where oid = 'public.move_opportunity_stage(uuid,text,text,timestamptz)'::regprocedure), array['search_path=""'], 'search_path is pinned');

-- ---- all 30 transitions: build a deal in each source stage, move it as a member, record the outcome
create temp table results (from_stage text, to_stage text, stage text, probability smallint, closed boolean, reason text, events bigint, summary text);
grant all on results to authenticated;
create function pg_temp.run_all() returns void language plpgsql as $$
declare
  s text; t text; did uuid; cur public.opportunities; got public.opportunities; ev bigint; sm text;
begin
  foreach s in array array['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] loop
    foreach t in array array['new', 'qualified', 'proposal', 'negotiation', 'won', 'lost'] loop
      continue when s = t;
      did := gen_random_uuid();
      insert into public.opportunities (id, organization_id, customer_id, title, stage, closed_at, lost_reason)
        values (did, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Deal ' || s || ' to ' || t, s,
                case when s in ('won', 'lost') then now() end, case when s = 'lost' then 'Old reason' end);
      select * into cur from public.opportunities o where o.id = did;
      perform tests.act_as('a_member');
      select * into got from public.move_opportunity_stage(did, t, 'Price too high', cur.updated_at);
      perform tests.reset();
      select count(*), max(a.summary) into ev, sm from public.activity_events a where a.entity_id = did and a.action = 'stage_changed';
      insert into results values (s, t, got.stage, got.probability_percent, got.closed_at is not null, got.lost_reason, ev, sm);
    end loop;
  end loop;
end $$;
select pg_temp.run_all();
select is((select count(*) from results), 30::bigint, 'there are 30 stage-to-stage transitions');
select is((select count(*) from results where stage <> to_stage), 0::bigint, 'every move lands in the requested stage');
select is((select count(*) from results where probability <> (case to_stage when 'new' then 10 when 'qualified' then 25 when 'proposal' then 50 when 'negotiation' then 75 when 'won' then 100 when 'lost' then 0 end)), 0::bigint, 'the probability resets to the new stage''s default every time');
select is((select count(*) from results where closed <> (to_stage in ('won', 'lost'))), 0::bigint, 'closed_at is set exactly for won and lost (reopening clears it)');
select is((select count(*) from results where reason is distinct from (case when to_stage = 'lost' then 'Price too high' end)), 0::bigint, 'the lost reason is stored for lost and cleared everywhere else (a reason sent with another stage is ignored)');
select is((select count(*) from results where events <> 1), 0::bigint, 'each move wrote exactly one stage_changed event (no extra update event for the probability)');
select is((select summary from results where from_stage = 'proposal' and to_stage = 'negotiation'), 'Sam Member moved "Deal proposal to negotiation" from Proposal to Negotiation', 'the event reads: who moved which deal from which stage to which');
select is((select count(*) from public.activity_events where entity_type = 'opportunity' and action = 'updated' and summary like '%probability%'), 0::bigint, 'and no separate probability event');

-- ---- rules
insert into public.opportunities (id, organization_id, customer_id, title, stage) values ('d1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Rules Deal', 'proposal');
create temp table v as select updated_at - interval '1 second' u from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001';
grant select on v to authenticated;
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''lost'', null, %L)', 'd1000000-0000-4000-8000-000000000001', (select updated_at from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'))), 'OD422', 'lost without a reason is refused (OD422)');
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''lost'', ''   '', %L)', 'd1000000-0000-4000-8000-000000000001', (select updated_at from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'))), 'OD422', 'a blank reason is refused');
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''lost'', repeat(''r'', 501), %L)', 'd1000000-0000-4000-8000-000000000001', (select updated_at from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'))), 'OD422', 'a reason over 500 characters is refused');
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''lost'', repeat(''r'', 500), %L)', 'd1000000-0000-4000-8000-000000000001', (select updated_at from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'))), 'ok', 'exactly 500 is fine');
select is((select stage from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 'lost', 'and the deal is lost');
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''archived'', null, now())', 'd1000000-0000-4000-8000-000000000001')), 'OD422', 'an unknown stage is refused');

-- no-op: same stage, no event, no new version
create temp table w as select updated_at u from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001';
grant select on w to authenticated;
create temp table ev_before as select count(*) n from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000001';
select tests.act_as('a_member');
select public.move_opportunity_stage('d1000000-0000-4000-8000-000000000001', 'lost', 'Another reason', (select u from w));
select tests.reset();
select is((select updated_at = (select u from w) and lost_reason <> 'Another reason' from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), true, 'moving to the current stage changes nothing (not even the reason or the version)');
select is((select count(*) from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000001'), (select n from ev_before), 'and writes no event');

-- ---- concurrency
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''new'', null, %L)', 'd1000000-0000-4000-8000-000000000001', (select u from v))), 'OD409', 'a stale version is refused (OD409) even though the deal changed since');
select is((select stage from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 'lost', 'and nothing was overwritten');
select is(tests.sqlstate_of_as('a_member', format('select public.move_opportunity_stage(%L, ''lost'', null, %L)', 'd1000000-0000-4000-8000-000000000001', (select u from v))), 'OD409', 'a stale no-op is also refused (the caller''s view is old)');

-- ---- who may
insert into public.opportunities (id, organization_id, customer_id, title) values ('d1000000-0000-4000-8000-000000000002', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Role Deal');
create temp table r as select updated_at u from public.opportunities where id = 'd1000000-0000-4000-8000-000000000002';
grant select on r to authenticated;
select is(tests.sqlstate_of_as('a_viewer', format('select public.move_opportunity_stage(%L, ''qualified'', null, %L)', 'd1000000-0000-4000-8000-000000000002', (select u from r))), 'OD403', 'a viewer is refused (OD403)');
select is(tests.sqlstate_of_as('b_owner', format('select public.move_opportunity_stage(%L, ''qualified'', null, %L)', 'd1000000-0000-4000-8000-000000000002', (select u from r))), 'OD404', 'another tenant''s deal is OD404, the same as a missing one');
select is(tests.sqlstate_of_as('a_owner', format('select public.move_opportunity_stage(%L, ''qualified'', null, now())', gen_random_uuid())), 'OD404', 'a missing deal is OD404');
select is(tests.sqlstate_of_as('outsider', format('select public.move_opportunity_stage(%L, ''qualified'', null, %L)', 'd1000000-0000-4000-8000-000000000002', (select u from r))), 'OD404', 'a user with no membership gets OD404');
select is(tests.sqlstate_of_as('a_admin', format('select public.move_opportunity_stage(%L, ''qualified'', null, %L)', 'd1000000-0000-4000-8000-000000000002', (select u from r))), 'ok', 'an admin may');
select is((select stage from public.opportunities where id = 'd1000000-0000-4000-8000-000000000002'), 'qualified', 'and the deal moved');

-- an expired demo is read-only
insert into public.opportunities (id, organization_id, customer_id, title) values ('d1000000-0000-4000-8000-000000000003', tests.org_id('g1'), 'c1000000-0000-4000-8000-0000000000d1', 'Demo Deal');
create temp table g as select updated_at u from public.opportunities where id = 'd1000000-0000-4000-8000-000000000003';
grant select on g to authenticated;
select is(tests.sqlstate_of_as('g1', format('select public.move_opportunity_stage(%L, ''qualified'', null, %L)', 'd1000000-0000-4000-8000-000000000003', (select u from g))), 'ok', 'a guest may move deals in a live demo');
update public.organizations set expires_at = now() - interval '1 minute' where id = tests.org_id('g1');
select is(tests.sqlstate_of_as('g1', format('select public.move_opportunity_stage(%L, ''proposal'', null, %L)', 'd1000000-0000-4000-8000-000000000003', (select updated_at from public.opportunities where id = 'd1000000-0000-4000-8000-000000000003'))), 'OD403', 'but not once the demo has expired');

-- ---- atomic: a failure after the row update removes the event too
create temp table before_counts as select (select count(*) from public.activity_events) e;
do $$
declare cur public.opportunities;
begin
  begin
    select * into cur from public.opportunities where id = 'd1000000-0000-4000-8000-000000000002';
    perform tests.act_as('a_owner');
    perform public.move_opportunity_stage(cur.id, 'negotiation', null, cur.updated_at);
    raise exception 'forced';
  exception when others then null; end;
  perform tests.reset();
end $$;
select is((select count(*) from public.activity_events) = (select e from before_counts) and (select stage from public.opportunities where id = 'd1000000-0000-4000-8000-000000000002') = 'qualified', true, 'a failure after the update rolls back the stage and its event together');

select * from finish();
rollback;
