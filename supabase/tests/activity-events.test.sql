-- pgTAP tests for the append-only activity store (SIT-195, PRD 5.3 and 11.2: no untrusted client can write audit events).
begin;
select plan(54);
select tests.create_fixtures();

-- Seed events as the trusted server role (what the SIT-201 logging functions will do).
insert into public.activity_events (id, organization_id, entity_type, entity_id, action, actor_user_id, summary, changes) values
  ('e1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'customer', 'c1000000-0000-4000-8000-000000000001', 'created', tests.uid('a_owner'), 'Created customer Acme', '{"name":"Acme"}'),
  ('e1000000-0000-4000-8000-000000000002', tests.org_id('a'), 'task', 'c2000000-0000-4000-8000-000000000002', 'completed', tests.uid('a_member'), 'Completed task', '{}'),
  ('e1000000-0000-4000-8000-000000000003', tests.org_id('b'), 'customer', 'c3000000-0000-4000-8000-000000000003', 'created', tests.uid('b_owner'), 'Created customer Globex', '{}'),
  ('e1000000-0000-4000-8000-000000000004', tests.org_id('g1'), 'opportunity', 'c4000000-0000-4000-8000-000000000004', 'stage_changed', tests.uid('g1'), 'Moved to Qualified', '{"stage":"qualified"}'),
  ('e1000000-0000-4000-8000-000000000005', tests.org_id('g2'), 'opportunity', 'c5000000-0000-4000-8000-000000000005', 'created', tests.uid('g2'), 'Created deal', '{}');

-- ---- shape
select has_table('public', 'activity_events', 'the table exists');
select is((select relrowsecurity from pg_class where oid = 'public.activity_events'::regclass), true, 'row level security is on');
select is((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'activity_events'),
  'id,organization_id,entity_type,entity_id,action,actor_user_id,summary,changes,created_at', 'columns as specified');
select is((select array_agg(indexname::text order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'activity_events'),
  array['activity_events_org_created_idx', 'activity_events_org_entity_idx', 'activity_events_pkey'], 'the two lookup indexes exist');
select is((select indexdef like '%(organization_id, created_at DESC)' from pg_indexes where indexname = 'activity_events_org_created_idx'), true, 'newest-first per organization');
select is((select indexdef like '%(organization_id, entity_type, entity_id)' from pg_indexes where indexname = 'activity_events_org_entity_idx'), true, 'and per entity');
select is((select count(*) from pg_constraint where conrelid = 'public.activity_events'::regclass and contype = 'f' and confrelid <> 'public.organizations'::regclass and confrelid <> 'auth.users'::regclass), 0::bigint,
  'entity_id is not a foreign key (events outlive their entities)');

-- ---- constraints (as the trusted server role)
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'invoice', gen_random_uuid(), 'created', 's')$$, '23514', null, 'an unknown entity type is refused');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'exploded', 's')$$, '23514', null, 'an unknown action is refused');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', '')$$, '23514', null, 'an empty summary is refused');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', repeat('x', 301))$$, '23514', null, 'a summary over 300 characters is refused');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary, changes) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', 's', '[1,2]')$$, '23514', null, 'changes must be an object, not an array');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary, changes) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', 's', '"text"')$$, '23514', null, 'nor a bare string');
select lives_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary, changes) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', 's', jsonb_build_object('k', repeat('x', 4096 - 9)))$$, 'changes of exactly 4096 bytes are accepted');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary, changes) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', 's', jsonb_build_object('k', repeat('x', 4096)))$$, '23514', null, 'changes over the 4 KB cap are rejected');
select throws_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (gen_random_uuid(), 'customer', gen_random_uuid(), 'created', 's')$$, '23503', null, 'the organization must exist');
select lives_ok($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'customer', gen_random_uuid(), 'created', 'no actor')$$, 'a system event may have no actor');

-- ---- grants: members read, nobody writes
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'activity_events' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon and PUBLIC hold nothing');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'activity_events' and grantee = 'authenticated'), 'SELECT', 'authenticated holds SELECT only');

-- ---- reads: own organization only
select tests.act_as('a_owner');
select is((select count(*) from public.activity_events), (select count(*) from public.activity_events where organization_id = tests.org_id('a')), 'A sees only organization A events');
select is(tests.visible_count('public.activity_events', format('organization_id = %L', tests.org_id('b'))), 0::bigint, 'and none of B''s');
select is(tests.visible_count('public.activity_events', format('id = %L', 'e1000000-0000-4000-8000-000000000003')), 0::bigint, 'not even by id');
select tests.act_as('a_viewer');
select is(tests.visible_count('public.activity_events', format('id = %L', 'e1000000-0000-4000-8000-000000000001')), 1::bigint, 'a viewer reads their organization''s history');
select tests.act_as('outsider');
select is((select count(*) from public.activity_events), 0::bigint, 'a user with no membership sees nothing');
select tests.act_as('g1');
select is((select count(*) from public.activity_events), 1::bigint, 'a guest sees only their own demo''s events');
select is(tests.visible_count('public.activity_events', format('organization_id = %L', tests.org_id('g2'))), 0::bigint, 'not another guest''s');
select tests.act_as_anon();
select is(tests.denied('select * from public.activity_events'), true, 'a signed-out caller is refused');
select tests.reset();

-- ---- writes by clients: every path is refused
select is(tests.denied_as('a_owner', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'an owner cannot insert an event');
select is(tests.denied_as('a_admin', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'nor an admin');
select is(tests.denied_as('g1', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('g1'))), true, 'nor a guest');
select is(tests.denied_as('a_owner', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''into B'')', tests.org_id('b'))), true, 'nor into another organization');
select is(tests.denied_as_anon('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (gen_random_uuid(), ''customer'', gen_random_uuid(), ''created'', ''x'')'), true, 'nor a visitor');
select is(tests.denied_as('a_owner', 'update public.activity_events set summary = ''rewritten'''), true, 'an owner cannot update events');
select is(tests.denied_as('a_owner', 'delete from public.activity_events'), true, 'cannot delete them');
select is(tests.denied_as('a_owner', 'truncate public.activity_events'), true, 'nor truncate');
select is(tests.denied_as('g1', 'update public.activity_events set summary = ''rewritten'''), true, 'a guest cannot update');
select is(tests.denied_as('g1', 'delete from public.activity_events'), true, 'or delete');
select is((select summary from public.activity_events where id = 'e1000000-0000-4000-8000-000000000001'), 'Created customer Acme', 'and history is unchanged');

-- ---- defence in depth: even with grants and policies widened by mistake, the trigger still stops a browser role
grant update, delete on public.activity_events to authenticated;
create policy zz_open_update on public.activity_events for update to authenticated using (true) with check (true);
create policy zz_open_delete on public.activity_events for delete to authenticated using (true);
select tests.act_as('a_owner');
select throws_ok($$update public.activity_events set summary = 'rewritten' where organization_id = tests.org_id('a')$$, 'OD403', 'Activity history cannot be changed.', 'the trigger refuses an update even if granted');
select throws_ok($$delete from public.activity_events where organization_id = tests.org_id('a')$$, 'OD403', 'Activity history cannot be deleted.', 'and a delete');
select tests.reset();
select throws_ok($$update public.activity_events set summary = 'rewritten'$$, 'OD403', null, 'even the server role cannot update history');
revoke update, delete on public.activity_events from authenticated;
drop policy zz_open_update on public.activity_events;
drop policy zz_open_delete on public.activity_events;

-- ---- the trusted path: cleanup and reset can delete
select lives_ok($$delete from public.activity_events where id = 'e1000000-0000-4000-8000-000000000005'$$, 'the server role may delete (the cleanup path)');
select is((select count(*) from public.activity_events where organization_id = tests.org_id('g2')), 0::bigint, 'and it did');
select is((select count(*) from public.activity_events where organization_id = tests.org_id('g1')), 1::bigint, 'only that one');

-- ---- the demo reset clears the guest's events (the registered clear function), and leaves other workspaces alone
select tests.act_as('g1');
select lives_ok(format('select public.reset_demo_workspace(%L)', tests.org_id('g1')), 'a guest resets their demo');
select tests.reset();
select is((select count(*) from public.activity_events where id = 'e1000000-0000-4000-8000-000000000004'), 0::bigint, 'the reset removed that demo''s old events');
select is((select count(*) from public.activity_events where organization_id = tests.org_id('g1') and actor_user_id is not null), 0::bigint, 'what remains is the new seed''s System events only');
select is((select count(*) from public.activity_events where organization_id = tests.org_id('a')) > 0, true, 'and left organization A''s alone');

-- ---- deleting an organization removes its events (cleanup of an expired demo)
insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('expired'), 'task', gen_random_uuid(), 'created', 'old demo event');
select is((public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int >= 1, true, 'the cleanup deletes the expired demo');
select is((select count(*) from public.activity_events where organization_id = tests.org_id('expired')), 0::bigint, 'and its events went with it');

-- ---- the demo cap applies to demo workspaces only
update private.app_limits set value = 2 where key = 'demo_cap_activity_events';
select lives_ok(format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''1'')', tests.org_id('g2')), 'demo event 1 of 2');
select lives_ok(format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''2'')', tests.org_id('g2')), 'demo event 2 of 2');
select throws_ok(format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''3'')', tests.org_id('g2')), 'OD429', null, 'the third is refused with the demo cap error');
select lives_ok(format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''real org'')', tests.org_id('a')), 'a real organization has no cap');

select * from finish();
rollback;
