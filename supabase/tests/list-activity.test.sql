-- pgTAP tests for public.list_activity (SIT-245): shape, filters, stable order and paging, organization-time date ranges,
-- actor names only through memberships, and tenant isolation.
begin;
select plan(37);
select tests.create_fixtures();
update public.profiles set display_name = 'Olive Owner' where id = tests.uid('a_owner');
update public.profiles set display_name = 'Mia Member' where id = tests.uid('a_member');
update public.organizations set timezone = 'Pacific/Kiritimati' where id = tests.org_id('a'); -- UTC+14

select is((select prosecdef from pg_proc where proname = 'list_activity' and pronamespace = 'public'::regnamespace), true, 'SECURITY DEFINER (profiles are private)');
select ok(has_function_privilege('authenticated', 'public.list_activity(uuid,text,uuid,text,uuid,boolean,date,date,boolean,integer,integer)', 'execute') and not has_function_privilege('anon', 'public.list_activity(uuid,text,uuid,text,uuid,boolean,date,date,boolean,integer,integer)', 'execute'), 'EXECUTE for authenticated only');

-- events: 6 for A on known instants, 2 for B. entity ids are plain uuids (events outlive their rows).
insert into public.activity_events (id, organization_id, entity_type, entity_id, action, actor_user_id, summary, changes, created_at) values
  ('e0000000-0000-4000-8000-000000000001', tests.org_id('a'), 'customer', 'c0000000-0000-4000-8000-000000000001', 'created',  tests.uid('a_owner'),  'Olive Owner created customer "X"', '{}', '2026-10-01 09:00+00'),
  ('e0000000-0000-4000-8000-000000000002', tests.org_id('a'), 'customer', 'c0000000-0000-4000-8000-000000000001', 'updated',  tests.uid('a_member'), 'Mia Member updated customer "X" (status)', '{"status":{"old":"lead","new":"active"},"_content_changed":["notes"]}', '2026-10-02 09:00+00'),
  ('e0000000-0000-4000-8000-000000000003', tests.org_id('a'), 'task',     'd0000000-0000-4000-8000-000000000001', 'completed',tests.uid('a_member'), 'Mia Member completed task "T"', '{}', '2026-10-02 09:00+00'),
  ('e0000000-0000-4000-8000-000000000004', tests.org_id('a'), 'task',     'd0000000-0000-4000-8000-000000000001', 'created',  null,                  'System created task "T"', '{}', '2026-10-03 09:00+00'),
  ('e0000000-0000-4000-8000-000000000005', tests.org_id('a'), 'customer', 'c0000000-0000-4000-8000-000000000001', 'archived', tests.uid('b_owner'),  'Someone archived customer "X"', '{}', '2026-10-04 09:00+00'),
  -- 2026-10-04 23:00 UTC is already 2026-10-05 13:00 in Kiritimati
  ('e0000000-0000-4000-8000-000000000006', tests.org_id('a'), 'customer', 'c0000000-0000-4000-8000-000000000002', 'created',  tests.uid('a_owner'),  'Olive Owner created customer "Y"', '{}', '2026-10-04 23:00+00'),
  -- exactly local midnight at the start of Oct 4 in Kiritimati (2026-10-04 00:00 +14 = 2026-10-03 10:00 UTC)
  ('e0000000-0000-4000-8000-000000000007', tests.org_id('a'), 'task',     'd0000000-0000-4000-8000-000000000002', 'created',  tests.uid('a_owner'),  'Olive Owner created task "Midnight"', '{}', '2026-10-03 10:00+00'),
  ('e0000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'customer', 'c0000000-0000-4000-8000-0000000000b1', 'created',  tests.uid('b_owner'),  'B created customer "Secret"', '{}', '2026-10-03 09:00+00'),
  ('e0000000-0000-4000-8000-0000000000b2', tests.org_id('b'), 'task',     'd0000000-0000-4000-8000-0000000000b1', 'created',  null,                  'System created task "BT"', '{}', '2026-10-04 09:00+00');

create function tests.ids(r jsonb) returns text language sql as $$ select string_agg(right(i ->> 'id', 2), ',' order by ord) from jsonb_array_elements(r -> 'items') with ordinality as t(i, ord) $$;
grant execute on function tests.ids(jsonb) to public;

select tests.act_as('a_viewer');
select is((public.list_activity(tests.org_id('a')) ->> 'total')::int, 7, 'a viewer reads A''s 7 events (B''s are not counted)');
select is(tests.ids(public.list_activity(tests.org_id('a'))), '06,05,07,04,03,02,01', 'newest first; the two events at the same instant are ordered by id descending (stable)');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_newest_first => false)), '01,02,03,04,07,05,06', 'oldest first when asked; ties by id ascending');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_limit => 2, p_offset => 0)) || '|' || tests.ids(public.list_activity(tests.org_id('a'), p_limit => 2, p_offset => 2)) || '|' || tests.ids(public.list_activity(tests.org_id('a'), p_limit => 2, p_offset => 4)), '06,05|07,04|03,02', 'pages of 2 neither repeat nor skip');
select is(public.list_activity(tests.org_id('a'), p_limit => 2, p_offset => 10) -> 'items', '[]'::jsonb, 'a page past the end is empty');
select is((public.list_activity(tests.org_id('a'), p_limit => 2, p_offset => 10) ->> 'total')::int, 7, 'and still reports the real total');

-- filters
select is(tests.ids(public.list_activity(tests.org_id('a'), p_entity_type => 'customer', p_entity_id => 'c0000000-0000-4000-8000-000000000001')), '05,02,01', 'an entity''s timeline: only that record''s events');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_entity_type => 'task')), '07,04,03', 'entity type filter');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_action => 'created')), '06,07,04,01', 'action filter');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_actor => tests.uid('a_member'))), '03,02', 'actor filter');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_system_only => true)), '04', 'system-only filter');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_entity_type => 'customer', p_action => 'created', p_actor => tests.uid('a_owner'))), '06,01', 'filters combine');

-- date range: inclusive days in the ORGANIZATION'S zone (Kiritimati, UTC+14)
select is(tests.ids(public.list_activity(tests.org_id('a'), p_from => '2026-10-05', p_to => '2026-10-05')), '06', 'the event at 23:00 UTC on Oct 4 belongs to Oct 5 in Kiritimati');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_from => '2026-10-04', p_to => '2026-10-04')), '05,07', 'and Oct 4 there starts exactly at local midnight (an event AT 00:00 is included) and holds the 09:00 UTC event');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_from => '2026-10-02', p_to => '2026-10-03')), '04,03,02', 'a multi-day range includes both end days');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_from => '2026-10-05')), '06', 'open-ended from');
select is(tests.ids(public.list_activity(tests.org_id('a'), p_to => '2026-10-01')), '01', 'open-ended to');

-- items: names, changes, shape
select is((select i ->> 'actorName' from jsonb_array_elements(public.list_activity(tests.org_id('a'), p_action => 'updated') -> 'items') i), 'Mia Member', 'a member actor is named');
select is((select i ->> 'actorName' from jsonb_array_elements(public.list_activity(tests.org_id('a'), p_system_only => true) -> 'items') i), 'System', 'no actor reads as System');
select is((select i ->> 'actorName' from jsonb_array_elements(public.list_activity(tests.org_id('a'), p_action => 'archived') -> 'items') i), null, 'an actor who is NOT a member of this workspace is never named (null; the API says Former member)');
select is((select i -> 'changes' from jsonb_array_elements(public.list_activity(tests.org_id('a'), p_action => 'updated') -> 'items') i), '{"status":{"old":"lead","new":"active"},"_content_changed":["notes"]}'::jsonb, 'whitelisted changes are returned as stored');
select is((select array_agg(k order by k) from jsonb_object_keys((public.list_activity(tests.org_id('a'), p_limit => 1) -> 'items') -> 0) k), array['action','actorName','actorUserId','changes','createdAt','entityId','entityState','entityType','id','summary'], 'each item has exactly the documented fields');
select tests.reset();

-- isolation and access
select tests.act_as('b_owner');
select is(tests.ids(public.list_activity(tests.org_id('b'))), 'b2,b1', 'B sees only B''s events');
select is(public.list_activity(tests.org_id('b'), p_entity_id => 'c0000000-0000-4000-8000-000000000001') -> 'items', '[]'::jsonb, 'A''s record id filtered inside B returns nothing');
select is(tests.sqlstate_of(format($$select public.list_activity(%L)$$, tests.org_id('a'))), 'OD404', 'B''s owner asking for A gets OD404');
select tests.reset();
select tests.act_as('outsider');
select is(tests.sqlstate_of(format($$select public.list_activity(%L)$$, tests.org_id('a'))), 'OD404', 'a non-member gets OD404');
select tests.reset();
select tests.act_as_anon();
select is(tests.sqlstate_of(format($$select public.list_activity(%L)$$, tests.org_id('a'))), '42501', 'anon cannot call it');
select tests.reset();
select tests.act_as('g1');
select is((public.list_activity(tests.org_id('g1')) ->> 'total')::int, 0, 'a guest reads their own (empty here) feed');
select tests.reset();

-- ---- entityState: where an event's record stands, resolved inside the organization only (SIT-257)
insert into public.customers (id, organization_id, display_name, archived_at) values
  ('c5000000-0000-4000-8000-000000000001', tests.org_id('g1'), 'Live', null),
  ('c5000000-0000-4000-8000-000000000002', tests.org_id('g1'), 'Archived one', now()),
  ('c5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'B customer', null);
insert into public.activity_events (id, organization_id, entity_type, entity_id, action, summary, created_at) values
  ('e5000000-0000-4000-8000-000000000001', tests.org_id('g1'), 'customer', 'c5000000-0000-4000-8000-000000000001', 'created', 'x', now() - interval '4 minutes'),
  ('e5000000-0000-4000-8000-000000000002', tests.org_id('g1'), 'customer', 'c5000000-0000-4000-8000-000000000002', 'archived', 'x', now() - interval '3 minutes'),
  ('e5000000-0000-4000-8000-000000000003', tests.org_id('g1'), 'customer', 'c5000000-0000-4000-8000-0000000000b1', 'updated', 'x', now() - interval '2 minutes'),
  ('e5000000-0000-4000-8000-000000000004', tests.org_id('g1'), 'quote', 'c5000000-0000-4000-8000-000000000009', 'sent', 'x', now() - interval '1 minutes');
select tests.act_as('g1');
select is((select string_agg(i ->> 'entityState', ',' order by i ->> 'createdAt') from jsonb_array_elements(public.list_activity(tests.org_id('g1')) -> 'items') i where i ->> 'summary' = 'x'), 'active,archived,missing,missing', 'an active record is "active", an archived one "archived" (still linkable), another tenant''s record id and a kind with no page are "missing"');
select is((select i ->> 'entityState' from jsonb_array_elements(public.list_activity(tests.org_id('g1'), p_entity_id => 'c5000000-0000-4000-8000-0000000000b1') -> 'items') i where i ->> 'summary' = 'x'), 'missing', 'a record of another organization never resolves, so it can never be linked');
select tests.reset();
delete from public.customers where id = 'c5000000-0000-4000-8000-000000000001';
select tests.act_as('g1');
select is((select i ->> 'entityState' from jsonb_array_elements(public.list_activity(tests.org_id('g1'), p_entity_id => 'c5000000-0000-4000-8000-000000000001') -> 'items') i where i ->> 'summary' = 'x'), 'missing', 'a deleted record is "missing" (its history stays, the link goes)');
select is((select count(*)::int from jsonb_array_elements(public.list_activity(tests.org_id('g1')) -> 'items') i where i ->> 'entityState' is null), 0, 'every item has a state');
select tests.reset();
-- quotes resolve too (SIT-222): active, archived, a record of another organization, and one that does not exist
insert into public.quotes (id, organization_id, customer_id, quote_number, title, archived_at) values
  ('f5000000-0000-4000-8000-000000000001', tests.org_id('g1'), 'c5000000-0000-4000-8000-000000000002', 'Q-000901', 'Live quote', null),
  ('f5000000-0000-4000-8000-000000000002', tests.org_id('g1'), 'c5000000-0000-4000-8000-000000000002', 'Q-000902', 'Archived quote', now()),
  ('f5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'c5000000-0000-4000-8000-0000000000b1', 'Q-000903', 'B quote', null);
delete from public.activity_events where entity_type = 'quote' and organization_id = tests.org_id('g1');
insert into public.activity_events (id, organization_id, entity_type, entity_id, action, summary, created_at) values
  ('e6000000-0000-4000-8000-000000000001', tests.org_id('g1'), 'quote', 'f5000000-0000-4000-8000-000000000001', 'created', 'q', now() - interval '4 minutes'),
  ('e6000000-0000-4000-8000-000000000002', tests.org_id('g1'), 'quote', 'f5000000-0000-4000-8000-000000000002', 'archived', 'q', now() - interval '3 minutes'),
  ('e6000000-0000-4000-8000-000000000003', tests.org_id('g1'), 'quote', 'f5000000-0000-4000-8000-0000000000b1', 'updated', 'q', now() - interval '2 minutes');
select tests.act_as('g1');
select is((select string_agg(i ->> 'entityState', ',' order by i ->> 'createdAt') from jsonb_array_elements(public.list_activity(tests.org_id('g1'), p_entity_type => 'quote') -> 'items') i where i ->> 'summary' = 'q'), 'active,archived,missing', 'an active quote is "active", an archived one "archived", another organization''s is "missing"');
select is((select count(*)::int from jsonb_array_elements(public.list_activity(tests.org_id('g1'), p_entity_type => 'quote') -> 'items') i where i ->> 'entityType' <> 'quote'), 0, 'the quote filter returns quote events only');
select is((select i ->> 'entityState' from jsonb_array_elements(public.list_activity(tests.org_id('g1'), p_entity_id => 'f5000000-0000-4000-8000-000000000001') -> 'items') i), 'active', 'one quote''s own history resolves too');
select tests.reset();
select * from finish();
rollback;
