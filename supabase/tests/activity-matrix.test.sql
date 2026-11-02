-- SIT-217: the activity logging matrix (PRD 11.2, 11.3 "missing audit events", US-07), run against EVERY entity table.
--
-- To cover a new entity table (tasks, quotes...), add ONE row to `cases` below and add 13 to the plan (its assertions).
-- Columns: table, entity_type, an INSERT statement for a valid row (with %L for id and organization_id), the safe column
-- to edit and its two values (text), the content column (free text) and its two values, the archive column.
begin;
select plan(37);
select tests.create_fixtures();
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

-- ---- one line per entity
create temp table cases (tbl text primary key, entity_type text, insert_sql text, safe_col text, safe_old text, safe_new text, content_col text, content_old text, archive_col text);
insert into cases values
  ('customers', 'customer',
    $$insert into public.customers (id, organization_id, display_name, status, notes) values (%L, %L, 'Matrix Customer', 'lead', 'original private note')$$,
    'status', 'lead', 'active', 'notes', 'original private note', 'archived_at'),
  ('opportunities', 'opportunity',
    $$insert into public.opportunities (id, organization_id, customer_id, title, description) values (%L, %L, 'c1000000-0000-4000-8000-0000000000a1', 'Matrix Deal', 'original private note')$$,
    'title', 'Matrix Deal', 'Matrix Deal Renamed', 'description', 'original private note', 'archived_at');
grant select on cases to authenticated;
insert into public.customers (id, organization_id, display_name) values ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Parent Customer');

-- ---- the scenario, run once per entity; observations land in `obs`
create temp table obs (tbl text, k text, v jsonb);
create function pg_temp.run_case(c cases) returns void language plpgsql as $$
declare
  rid uuid := gen_random_uuid();
  org uuid := tests.org_id('a');
  events_before bigint;
  ev jsonb;
  marker text := 'SECRET-MARKER-' || c.tbl;
begin
  -- create as a member
  perform tests.act_as('a_member');
  execute format(c.insert_sql, rid, org);
  perform tests.reset();
  select coalesce(jsonb_agg(jsonb_build_object('action', action, 'actor', actor_user_id, 'summary', summary) order by created_at, id), '[]') into ev from public.activity_events where entity_id = rid;
  insert into obs values (c.tbl, 'created', ev);

  -- edit a safe column as an admin
  perform tests.act_as('a_admin');
  execute format('update public.%I set %I = %L where id = %L', c.tbl, c.safe_col, c.safe_new, rid);
  perform tests.reset();
  select coalesce(jsonb_agg(jsonb_build_object('action', action, 'actor', actor_user_id, 'changes', changes) order by created_at, id), '[]') into ev from public.activity_events where entity_id = rid and action = 'updated';
  insert into obs values (c.tbl, 'safe_edit', ev);

  -- edit only the content column
  perform tests.act_as('a_admin');
  execute format('update public.%I set %I = %L where id = %L', c.tbl, c.content_col, marker, rid);
  perform tests.reset();
  select coalesce(jsonb_agg(changes order by created_at, id), '[]') into ev from public.activity_events where entity_id = rid and action = 'updated';
  insert into obs values (c.tbl, 'content_edit', ev);
  insert into obs values (c.tbl, 'marker_leaks', to_jsonb((select count(*) from public.activity_events where changes::text like '%' || marker || '%' or summary like '%' || marker || '%' or changes::text like '%' || c.content_old || '%' or summary like '%' || c.content_old || '%')));

  -- no-op updates: same values
  select count(*) into events_before from public.activity_events where entity_id = rid;
  perform tests.act_as('a_admin');
  execute format('update public.%I set %I = %I, %I = %I where id = %L', c.tbl, c.safe_col, c.safe_col, c.content_col, c.content_col, rid);
  execute format('update public.%I set updated_at = now() where id = %L', c.tbl, rid);
  perform tests.reset();
  insert into obs values (c.tbl, 'noop_new_events', to_jsonb((select count(*) from public.activity_events where entity_id = rid) - events_before));

  -- archive then restore
  perform tests.act_as('a_owner');
  execute format('update public.%I set %I = now() where id = %L', c.tbl, c.archive_col, rid);
  execute format('update public.%I set %I = null where id = %L', c.tbl, c.archive_col, rid);
  perform tests.reset();
  select coalesce(jsonb_agg(action order by created_at, id), '[]') into ev from public.activity_events where entity_id = rid and action in ('archived', 'restored');
  insert into obs values (c.tbl, 'archive_restore', ev);

  -- atomic rollback: a forced failure after the mutation removes the row change and its event
  select count(*) into events_before from public.activity_events;
  begin
    perform tests.act_as('a_member');
    execute format(c.insert_sql, gen_random_uuid(), org);
    raise exception 'forced failure after the mutation';
  exception when others then
    perform tests.reset();
  end;
  insert into obs values (c.tbl, 'rollback_new_events', to_jsonb((select count(*) from public.activity_events) - events_before));
  insert into obs values (c.tbl, 'rollback_rows', to_jsonb((select count(*) from public.activity_events where summary like '%' || c.tbl || '%')));
end $$;
select pg_temp.run_case(c) from cases c;

-- ---- per-entity assertions (11 here, plus 2 for the seed: 13 per entity)
select is((v -> 0 ->> 'action') || '|' || jsonb_array_length(v), 'created|1', tbl || ': creating a row writes exactly one created event') from obs where k = 'created';
select is((v -> 0 ->> 'actor')::uuid, tests.uid('a_member'), tbl || ': the actor is the member who did it') from obs where k = 'created';
select is((v -> 0 ->> 'summary') like 'Sam Member created ' || (select entity_type from cases where cases.tbl = obs.tbl) || '%', true, tbl || ': the summary names the actor and the record kind') from obs where k = 'created';
select is(jsonb_array_length(v), 1, tbl || ': editing a safe column writes exactly one updated event') from obs where k = 'safe_edit';
select is((v -> 0 -> 'changes') = jsonb_build_object((select safe_col from cases where cases.tbl = obs.tbl), jsonb_build_object('old', (select safe_old from cases where cases.tbl = obs.tbl), 'new', (select safe_new from cases where cases.tbl = obs.tbl))), true, tbl || ': its changes hold only that field, with old and new values') from obs where k = 'safe_edit';
select is((v -> 0 ->> 'actor')::uuid, tests.uid('a_admin'), tbl || ': an edit is attributed to the editor, not the creator') from obs where k = 'safe_edit';
select is(v -> 1, jsonb_build_object('_content_changed', jsonb_build_array((select content_col from cases where cases.tbl = obs.tbl))), tbl || ': editing only the content column logs its NAME and nothing else') from obs where k = 'content_edit';
select is(v::int, 0, tbl || ': neither the new nor the original content text appears in any event or summary') from obs where k = 'marker_leaks';
select is(v::int, 0, tbl || ': a no-op update (same values, or only updated_at) writes no event') from obs where k = 'noop_new_events';
select is(v, '["archived", "restored"]'::jsonb, tbl || ': archive then restore are two distinct events with the right actions') from obs where k = 'archive_restore';
select is(v::int, 0, tbl || ': a failure after the insert leaves no event behind (atomic)') from obs where k = 'rollback_new_events';

-- ---- the seed and cleanup have no actor and read as System (one assertion per entity)
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot as select public.bootstrap_demo_workspace() r;
grant select on boot to authenticated;
select tests.reset();
select is((select count(*) from public.activity_events e where e.organization_id = (select (r ->> 'organization_id')::uuid from boot) and e.entity_type = c.entity_type and e.actor_user_id is null and e.summary like 'System created %'), (select count(*) from public.activity_events e where e.organization_id = (select (r ->> 'organization_id')::uuid from boot) and e.entity_type = c.entity_type), c.tbl || ': every seeded event has no actor and reads as System') from cases c;
select is((select count(*) from public.activity_events e where e.organization_id = (select (r ->> 'organization_id')::uuid from boot) and e.entity_type = c.entity_type) > 0, true, c.tbl || ': the seed does log events') from cases c;

-- ---- shared: no client can write events or call the writer (once)
select is(tests.denied_as('a_owner', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'an owner cannot insert an event');
select is(tests.denied_as('a_member', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'a member cannot');
select is(tests.denied_as('g1', format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('g1'))), true, 'a guest cannot');
select is(tests.denied_as_anon('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (gen_random_uuid(), ''customer'', gen_random_uuid(), ''created'', ''x'')'), true, 'a visitor cannot');
select is(tests.denied_as('a_owner', 'update public.activity_events set summary = ''rewritten'''), true, 'no client can update events');
select is(tests.denied_as('a_owner', 'delete from public.activity_events'), true, 'nor delete them');
select is(tests.denied_as('a_owner', format('select private.log_activity(%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('a'))), true, 'nor call log_activity');
select is(tests.denied_as('g1', format('select private.log_activity(%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', tests.org_id('g1'))), true, 'a guest cannot call the writer either');
select is((select count(*) from public.activity_events where summary = 'forged'), 0::bigint, 'and no forged event exists');

-- ---- shared: oversized changes are rejected, not stored (once)
select throws_ok(format($q$select private.log_activity(%L, 'customer', gen_random_uuid(), 'updated', 'too big', (select jsonb_object_agg('field_' || lpad(i::text, 3, '0'), jsonb_build_object('old', repeat('a', 100), 'new', repeat('b', 100))) from generate_series(1, 60) i))$q$, tests.org_id('a')), '23514', null, 'a changes payload over the size cap is rejected by the database');
select is((select count(*) from public.activity_events where summary = 'too big'), 0::bigint, 'and nothing was stored');

select * from finish();
rollback;
