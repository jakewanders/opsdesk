-- pgTAP tests for the transactional activity logging mechanism (SIT-201; PRD 6.5, 11.2, 11.3 "missing audit events").
begin;
select plan(50);
select tests.create_fixtures();
update public.profiles set display_name = 'Pat Owner' where id = tests.uid('a_owner');
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

-- A probe entity shaped like customers: RLS, activity logging with safe, content and archive columns.
create table public.zz_things (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  status text not null default 'lead',
  amount_cents bigint,
  notes text,
  email text,
  archived_at timestamptz,
  updated_at timestamptz not null default now()
);
select private.attach_tenant_rls('public.zz_things');
select private.attach_activity_log('public.zz_things', 'customer', 'name', array['name', 'status', 'amount_cents'], array['notes', 'email'], 'archived_at');
create function private.zz_seed(org uuid) returns void language plpgsql as $$ begin insert into public.zz_things (organization_id, name) values (org, 'Seeded Co'); end $$;
create function private.zz_clear(org uuid) returns void language plpgsql as $$ begin delete from public.zz_things where organization_id = org; end $$;

-- ---- nothing here is callable by a browser role
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and p.proname in ('log_activity', 'log_entity_change', 'attach_activity_log', 'sanitize_activity_changes', 'activity_actor_id', 'activity_actor_name', 'activity_system_mode', 'activity_safe_scalar')
              and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))), 0::bigint,
  'no activity function is executable by anon, authenticated or PUBLIC');
select is(tests.denied_as('a_owner', format('select private.log_activity(%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'a signed-in user cannot call log_activity');
select is(tests.denied_as('g1', format('select private.log_activity(%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('g1'))), true, 'nor a guest');
select is(tests.denied_as_anon('select private.log_activity(gen_random_uuid(), ''customer'', gen_random_uuid(), ''created'', ''forged'')'), true, 'nor a visitor');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%activity%'), 0::bigint, 'and there is no function in the API schema to call');
select is(tests.denied_as('a_owner', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'direct inserts are still refused');

-- ---- create: one event, the right actor, the PRD summary shape
select tests.act_as('a_owner');
insert into public.zz_things (id, organization_id, name, status) values ('b1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'Warehouse Retrofit', 'lead');
select tests.reset();
select is((select count(*) from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 1::bigint, 'creating a row writes exactly one event');
select is((select action from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 'created', 'a created event');
select is((select summary from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 'Pat Owner created customer "Warehouse Retrofit"', 'with a human summary naming actor and record');
select is((select actor_user_id from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), tests.uid('a_owner'), 'the actor is auth.uid()');
select is((select organization_id from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), tests.org_id('a'), 'in the row''s organization');
select is((select entity_type from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 'customer', 'for the configured entity type');

-- ---- update: whitelisted fields with old and new, in the same transaction, by the real caller
select tests.act_as('a_member');
update public.zz_things set status = 'active', amount_cents = 12500 where id = 'b1000000-0000-4000-8000-000000000001';
select tests.reset();
select is((select count(*) from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' and action = 'updated'), 1::bigint, 'one update event for one update statement');
select is((select changes from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' and action = 'updated'),
  '{"status": {"old": "lead", "new": "active"}, "amount_cents": {"old": null, "new": 12500}}'::jsonb, 'changes hold the safe fields with old and new values (numbers stay numbers)');
select is((select summary from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' and action = 'updated'), 'Sam Member updated customer "Warehouse Retrofit" (amount_cents, status)', 'the summary lists the changed fields');
select is((select actor_user_id from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' and action = 'updated'), tests.uid('a_member'), 'the actor is the member who did it, not the owner');

-- ---- free text and contact data: recorded as changed, never with content
select tests.act_as('a_member');
update public.zz_things set notes = 'Called about the leaking boiler, wants a discount' where id = 'b1000000-0000-4000-8000-000000000001';
select tests.reset();
select is((select changes from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1), '{"_content_changed": ["notes"]}'::jsonb, 'a notes-only edit logs that notes changed, with no content');
select is((select summary from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1), 'Sam Member updated customer "Warehouse Retrofit" (notes)', 'and says so in the summary');
update public.zz_things set notes = 'second note', email = 'pat@secret.example', status = 'won' where id = 'b1000000-0000-4000-8000-000000000001';
select is((select changes from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1),
  '{"status": {"old": "active", "new": "won"}, "_content_changed": ["email", "notes"]}'::jsonb, 'a mixed edit keeps the safe field and only the NAMES of the content fields');
select is((select count(*) from public.activity_events where changes::text ~* 'boiler|discount|second note|secret.example'), 0::bigint, 'no note or e-mail text appears in any stored event');
select is((select count(*) from public.activity_events where summary ~* 'boiler|discount|second note|secret.example'), 0::bigint, 'nor in any summary');

-- ---- no-ops write nothing
select is((select count(*) from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 4::bigint, 'baseline before no-ops: created, updated, notes, mixed');
update public.zz_things set status = status where id = 'b1000000-0000-4000-8000-000000000001';
update public.zz_things set name = name, notes = notes where id = 'b1000000-0000-4000-8000-000000000001';
update public.zz_things set updated_at = now() + interval '1 hour' where id = 'b1000000-0000-4000-8000-000000000001';
update public.zz_things set status = 'won' where id = 'b1000000-0000-4000-8000-000000000001';
select is((select count(*) from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001'), 4::bigint, 'rewriting a value with itself, or touching only updated_at, writes no event');
update public.zz_things set status = 'x' where id = 'b1000000-0000-4000-8000-000000000999';
select is((select count(*) from public.activity_events where summary like '%x%' and entity_id = 'b1000000-0000-4000-8000-000000000999'), 0::bigint, 'an update that matches no row writes nothing');

-- ---- archive and restore
update public.zz_things set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000001';
select is((select action from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1), 'archived', 'archiving logs an archived event');
select is((select summary from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1), 'System archived customer "Warehouse Retrofit"', 'by the actor (System here: this session has no signed-in user)');
update public.zz_things set archived_at = null where id = 'b1000000-0000-4000-8000-000000000001';
select is((select action from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' order by created_at desc, id desc limit 1), 'restored', 'restoring logs a restored event');
select is((select count(*) from public.activity_events where entity_id = 'b1000000-0000-4000-8000-000000000001' and action = 'updated'), 3::bigint, 'and neither was also logged as a plain update');

-- ---- explicit calls (named transitions) are sanitized the same way
select private.log_activity(tests.org_id('a'), 'opportunity', 'b2000000-0000-4000-8000-000000000002', 'stage_changed',
  'Pat Owner moved "Warehouse Retrofit" from Proposal to Negotiation',
  '{"stage": {"old": "proposal", "new": "negotiation"}, "notes": {"old": "private text", "new": "more private text"}, "weird key": {"old": 1, "new": 2}, "amount_cents": {"old": {"a": 1}, "new": "x"}, "token": "abc"}');
select is((select summary from public.activity_events where entity_id = 'b2000000-0000-4000-8000-000000000002'), 'Pat Owner moved "Warehouse Retrofit" from Proposal to Negotiation', 'a named transition keeps the PRD summary format');
select is((select changes from public.activity_events where entity_id = 'b2000000-0000-4000-8000-000000000002'),
  '{"stage": {"old": "proposal", "new": "negotiation"}, "amount_cents": {"old": "[complex]", "new": "x"}, "_content_changed": ["notes", "token"]}'::jsonb,
  'the whitelist applies to explicit calls: content and secret fields reduced to names, odd keys dropped, complex values flattened');
select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'created', E'Line one\nline two\t' || repeat('x', 400), '[1,2]');
select is((select count(*) from public.activity_events where summary like 'Line one line two%' and char_length(summary) = 300 and changes = '{}'::jsonb), 1::bigint, 'control characters become spaces, the summary is cut at 300 and array changes become {}');
select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'created', 'long', jsonb_build_object('status', jsonb_build_object('old', repeat('y', 500), 'new', 'ok')));
select is((select char_length(changes -> 'status' ->> 'old') from public.activity_events where summary = 'long'), 120, 'a long value is cut to 120 characters');
select throws_ok($$select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'created', '   ')$$, null, 'An activity event needs a summary', 'an empty summary is refused');
select throws_ok($$select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'exploded', 'x')$$, '23514', null, 'an unknown action is refused by the table');
select throws_ok($$select private.log_activity(tests.org_id('a'), 'invoice', gen_random_uuid(), 'created', 'x')$$, '23514', null, 'an unknown entity type too');

-- ---- atomicity: the row and its event commit or roll back together
create temp table before_counts as select (select count(*) from public.zz_things) things, (select count(*) from public.activity_events) events;
do $$
begin
  begin
    insert into public.zz_things (organization_id, name) values (tests.org_id('a'), 'Doomed');
    raise exception 'forced failure after the mutation';
  exception when others then null;
  end;
end $$;
select is((select count(*) from public.zz_things), (select things from before_counts), 'a failure after the insert rolls the row back');
select is((select count(*) from public.activity_events), (select events from before_counts), 'and its event with it');
do $$
begin
  begin
    update public.zz_things set status = 'lost' where id = 'b1000000-0000-4000-8000-000000000001';
    raise exception 'forced failure after the update';
  exception when others then null;
  end;
end $$;
select is((select status from public.zz_things where id = 'b1000000-0000-4000-8000-000000000001'), 'won', 'a failed update leaves the old value');
select is((select count(*) from public.activity_events), (select events from before_counts), 'and no update event');

-- the event failing (here the demo cap) fails the mutation too: no change without its audit trail
update private.app_limits set value = 1 where key = 'demo_cap_activity_events';
select tests.act_as('g1');
select lives_ok(format('insert into public.zz_things (organization_id, name) values (%L, ''First in demo'')', tests.org_id('g1')), 'the first demo change is logged (cap 1)');
select throws_ok(format('insert into public.zz_things (organization_id, name) values (%L, ''Second in demo'')', tests.org_id('g1')), 'OD429', null, 'at the cap the second change is refused (429)');
select tests.reset();
select is((select count(*) from public.zz_things where name = 'Second in demo'), 0::bigint, 'and the row was not saved without its event');
update private.app_limits set value = 300 where key = 'demo_cap_activity_events';

-- ---- the System actor: seeds and cleanup have no actor
select private.register_demo_seeder('zz_things', 50, 'private.zz_seed(uuid)'::regprocedure, 1, 'private.zz_clear(uuid)'::regprocedure);
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot as select public.bootstrap_demo_workspace() r;
grant select on boot to authenticated;
select tests.reset();
select is((select actor_user_id from public.activity_events where organization_id = (select (r ->> 'organization_id')::uuid from boot) and summary like '%Seeded Co%'), null, 'seeded rows are logged with no actor');
select is((select summary from public.activity_events where organization_id = (select (r ->> 'organization_id')::uuid from boot) and summary like '%Seeded Co%'), 'System created customer "Seeded Co"', 'and shown as System');
select is(current_setting('opsdesk.actor_mode', true), '', 'the system actor mode is switched off again after seeding');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
insert into public.zz_things (organization_id, name) values ((select (r ->> 'organization_id')::uuid from boot), 'Guest made');
select tests.reset();
select is((select actor_user_id from public.activity_events where summary like '%Guest made%'), 'aa000000-0000-4000-8000-0000000000a1'::uuid, 'after the seed the guest''s own changes are attributed to the guest');

-- ---- back-dating is for the System only
select set_config('opsdesk.actor_mode', 'system', true);
select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'created', 'seeded and back-dated', '{}', now() - interval '60 days');
select set_config('opsdesk.actor_mode', '', true);
select is((select created_at < now() - interval '59 days' from public.activity_events where summary = 'seeded and back-dated'), true, 'the system seed can back-date an event');
select private.log_activity(tests.org_id('a'), 'task', gen_random_uuid(), 'created', 'not back-dated', '{}', now() - interval '60 days');
select is((select created_at > now() - interval '1 minute' from public.activity_events where summary = 'not back-dated'), true, 'anyone else is stamped now, whatever they pass');

-- ---- the attach helper checks its arguments
select throws_ok($$select private.attach_activity_log('public.zz_things', 'customer', 'name', array['no_such_column'])$$, 'P0001', null, 'a column that does not exist is refused at attach time');
select is((select count(*) from pg_trigger where tgrelid = 'public.zz_things'::regclass and tgname = 'zz_things_activity_log'), 1::bigint, 'the trigger is named after the table and is attached once');

select * from finish();
rollback;
