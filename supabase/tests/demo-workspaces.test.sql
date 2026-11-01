-- pgTAP tests for the demo-workspace support structures (SIT-191).
begin;
select plan(38);

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-0000-0000-000000000001', null, true),
  ('92000000-0000-0000-0000-000000000002', null, true),
  ('a1000000-0000-0000-0000-000000000001', 'real@example.com', false);
insert into public.organizations (id, name, kind, expires_at, created_by) values
  ('d1000000-0000-0000-0000-0000000000d1', 'Demo 1', 'demo', now() + interval '24 hours', '91000000-0000-0000-0000-000000000001'),
  ('d2000000-0000-0000-0000-0000000000d2', 'Demo 1b', 'demo', now() + interval '24 hours', '91000000-0000-0000-0000-000000000001'),
  ('d3000000-0000-0000-0000-0000000000d3', 'Demo 2', 'demo', now() + interval '24 hours', '92000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-00000000000a', 'Real Co', 'real', null, 'a1000000-0000-0000-0000-000000000001');
insert into public.memberships (organization_id, user_id, role) values
  ('d1000000-0000-0000-0000-0000000000d1', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('d2000000-0000-0000-0000-0000000000d2', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('d3000000-0000-0000-0000-0000000000d3', '92000000-0000-0000-0000-000000000002', 'owner'),
  ('a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'owner');

create or replace function pg_temp.act_as(r text, uid uuid, anon boolean default true) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', r, 'is_anonymous', anon)::text, true);
  execute format('set local role %I', r);
end $$;
grant execute on function pg_temp.act_as(text, uuid, boolean) to public;
create or replace function pg_temp.updated_rows(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin execute stmt; get diagnostics n = row_count; return n; end $$;
grant execute on function pg_temp.updated_rows(text) to public;

-- ---- structure
select has_table('public', 'demo_workspaces', 'the mapping table exists');
select ok((select relrowsecurity from pg_class where oid = 'public.demo_workspaces'::regclass), 'RLS is enabled');
select is((select private.demo_ttl()), interval '24 hours', 'the demo lifetime is 24 hours');
select ok(
  exists (select 1 from pg_indexes where tablename = 'organizations' and indexname = 'organizations_demo_expiry_idx' and indexdef like '%WHERE%kind%demo%'),
  'the cleanup index on demo expiry exists (partial, kind = demo)');

-- The cleanup query uses the partial index (seq scans are disabled so the tiny test table still shows the choice)
create or replace function pg_temp.explain_text(q text) returns text language plpgsql as $$
declare r record; out text := '';
begin for r in execute 'explain ' || q loop out := out || (r."QUERY PLAN") || E'\n'; end loop; return out; end $$;
set local enable_seqscan = off;
select ok(
  strpos(pg_temp.explain_text($q$select id from public.organizations where kind = 'demo' and expires_at < now() order by expires_at limit 100$q$), 'organizations_demo_expiry_idx') > 0,
  'the expired-demo cleanup query uses the partial expiry index');
reset enable_seqscan;

-- ---- uniqueness: one demo per identity, decided by the database
select lives_ok($$select private.register_demo_workspace('d1000000-0000-0000-0000-0000000000d1', '91000000-0000-0000-0000-000000000001')$$, 'a demo workspace can be registered');
select throws_ok($$select private.register_demo_workspace('d2000000-0000-0000-0000-0000000000d2', '91000000-0000-0000-0000-000000000001')$$, '23505', null, 'a second demo for the same identity is rejected by the database');
select lives_ok($$select private.register_demo_workspace('d3000000-0000-0000-0000-0000000000d3', '92000000-0000-0000-0000-000000000002')$$, 'a different identity gets its own demo');
select throws_ok($$select private.register_demo_workspace('d1000000-0000-0000-0000-0000000000d1', '92000000-0000-0000-0000-000000000002')$$, '23505', null, 'one organization cannot be mapped twice');
select throws_ok($$select private.register_demo_workspace('a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001')$$, '23503', null, 'a REAL organization cannot be registered as a demo (composite key)');
select throws_ok($$insert into public.demo_workspaces (organization_id, kind, user_id) values ('d2000000-0000-0000-0000-0000000000d2', 'real', '92000000-0000-0000-0000-000000000002')$$, '23514', null, 'the kind column is pinned to demo');
select is((select seed_version from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 0, 'a new workspace starts unseeded (version 0)');
select throws_ok($$update public.demo_workspaces set seed_version = 2 where organization_id = 'd1000000-0000-0000-0000-0000000000d1'$$, '23514', null, 'a seed version needs a seeded_at (consistency check)');

-- ---- trusted helpers
select lives_ok($$select private.record_demo_seed('d1000000-0000-0000-0000-0000000000d1', 3)$$, 'the seed version is recorded');
select is((select seed_version from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 3, 'and stored');
select ok((select seeded_at is not null from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 'with its time');
select throws_ok($$select private.record_demo_seed('d1000000-0000-0000-0000-0000000000d1', 0)$$, 'OD422', 'A seed version must be 1 or higher.', 'version 0 is refused');
select throws_ok($$select private.record_demo_seed('00000000-0000-0000-0000-000000000000', 1)$$, 'OD404', 'That demo workspace was not found.', 'an unknown workspace is refused');

select ok((select private.begin_demo_reset('d1000000-0000-0000-0000-0000000000d1') is not null), 'the first reset is allowed');
select throws_ok($$select private.begin_demo_reset('d1000000-0000-0000-0000-0000000000d1')$$, 'OD429', 'You can reset the demo once a minute. Try again shortly.', 'a second reset within a minute is throttled');
select ok((select last_reset_at is not null from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 'last_reset_at is recorded');
update public.demo_workspaces set last_reset_at = now() - interval '61 seconds' where organization_id = 'd1000000-0000-0000-0000-0000000000d1';
select lives_ok($$select private.begin_demo_reset('d1000000-0000-0000-0000-0000000000d1')$$, 'a reset is allowed again after a minute');
update public.demo_workspaces set last_reset_at = now() - interval '59 seconds' where organization_id = 'd1000000-0000-0000-0000-0000000000d1';
select throws_ok($$select private.begin_demo_reset('d1000000-0000-0000-0000-0000000000d1')$$, 'OD429', null, 'but not at 59 seconds');
select throws_ok($$select private.begin_demo_reset('00000000-0000-0000-0000-000000000000')$$, 'OD404', null, 'resetting an unknown workspace is refused');

-- ---- browser clients: read own row only, write nothing
select pg_temp.act_as('authenticated', '91000000-0000-0000-0000-000000000001');
select is((select count(*) from public.demo_workspaces), 1::bigint, 'a guest reads only their own workspace row');
select is((select user_id from public.demo_workspaces), '91000000-0000-0000-0000-000000000001'::uuid, 'and it is theirs');
select throws_ok($$update public.demo_workspaces set last_reset_at = null$$, '42501', null, 'a guest cannot clear last_reset_at (no grant)');
select throws_ok($$update public.demo_workspaces set seed_version = 99$$, '42501', null, 'a guest cannot change the seed version');
select throws_ok($$update public.organizations set expires_at = now() + interval '1 year' where id = 'd1000000-0000-0000-0000-0000000000d1'$$, '42501', null, 'a guest cannot extend expires_at');
select throws_ok($$insert into public.demo_workspaces (organization_id, user_id) values ('d2000000-0000-0000-0000-0000000000d2', '91000000-0000-0000-0000-000000000001')$$, '42501', null, 'a guest cannot insert a mapping');
select throws_ok($$delete from public.demo_workspaces$$, '42501', null, 'a guest cannot delete a mapping');
select throws_ok($$select private.begin_demo_reset('d1000000-0000-0000-0000-0000000000d1')$$, '42501', null, 'a guest cannot call the throttle helper directly');
reset role;
select pg_temp.act_as('anon', null);
select throws_ok($$select * from public.demo_workspaces$$, '42501', null, 'anon cannot read the table');
reset role;

-- ---- even with an accidental grant, the triggers and restrictive policies hold
grant update on public.demo_workspaces to authenticated;
select pg_temp.act_as('authenticated', '91000000-0000-0000-0000-000000000001');
select is(pg_temp.updated_rows('update public.demo_workspaces set last_reset_at = null'), 0::bigint, 'a restrictive policy blocks update even after an accidental grant');
reset role;
alter table public.demo_workspaces disable row level security;
select pg_temp.act_as('authenticated', '91000000-0000-0000-0000-000000000001');
select throws_ok($$update public.demo_workspaces set last_reset_at = null$$, 'OD403', 'This field cannot be changed.', 'the trigger refuses last_reset_at for a client even with RLS off and a grant');
select throws_ok($$update public.demo_workspaces set user_id = '92000000-0000-0000-0000-000000000002'$$, 'OD403', 'This field cannot be changed.', 'and re-pointing the identity');
reset role;

-- ---- cascade: removing the organization removes the mapping (the cleanup path), freeing the identity
delete from public.organizations where id = 'd1000000-0000-0000-0000-0000000000d1';
select is((select count(*) from public.demo_workspaces where user_id = '91000000-0000-0000-0000-000000000001'), 0::bigint, 'deleting the demo organization removes its mapping');
select lives_ok($$select private.register_demo_workspace('d2000000-0000-0000-0000-0000000000d2', '91000000-0000-0000-0000-000000000001')$$, 'and the identity can then get a fresh demo');

select * from finish();
rollback;
