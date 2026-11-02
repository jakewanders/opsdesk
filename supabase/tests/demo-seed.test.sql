-- pgTAP tests for the demo seed registry and the fictional-data fixtures (SIT-192).
begin;
select plan(50);
-- These tests count seeders from an empty registry; the permanent ones (activity_events, ...) are set aside in this transaction.
delete from private.demo_seeders;

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-0000-0000-000000000001', null, true),
  ('92000000-0000-0000-0000-000000000002', null, true),
  ('a1000000-0000-0000-0000-000000000001', 'real@example.com', false);
insert into public.organizations (id, name, kind, expires_at) values
  ('d1000000-0000-0000-0000-0000000000d1', 'Demo A', 'demo', now() + interval '24 hours'),
  ('d2000000-0000-0000-0000-0000000000d2', 'Demo B', 'demo', now() + interval '24 hours'),
  ('d3000000-0000-0000-0000-0000000000d3', 'Demo unmapped', 'demo', now() + interval '24 hours'),
  ('a0000000-0000-0000-0000-00000000000a', 'Real Co', 'real', null);
insert into public.memberships (organization_id, user_id, role) values
  ('d1000000-0000-0000-0000-0000000000d1', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('d2000000-0000-0000-0000-0000000000d2', '92000000-0000-0000-0000-000000000002', 'owner'),
  ('d3000000-0000-0000-0000-0000000000d3', '92000000-0000-0000-0000-000000000002', 'owner'),
  ('a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'owner');
select private.register_demo_workspace('d1000000-0000-0000-0000-0000000000d1', '91000000-0000-0000-0000-000000000001');
select private.register_demo_workspace('d2000000-0000-0000-0000-0000000000d2', '92000000-0000-0000-0000-000000000002');

-- ---------------------------------------------------------------------------------------------
-- Fixtures: banned-pattern lint over every fixture value
-- ---------------------------------------------------------------------------------------------
select is((select count(*) from generate_series(1, 120) i where private.demo_email(i) !~ '^[a-z]+\.[a-z]+@example\.com$'), 0::bigint, 'every fixture email is first.last@example.com');
select is((select count(*) from generate_series(1, 120) i where private.demo_phone(i) !~ '^\(202\) 555-01[0-9]{2}$'), 0::bigint, 'every fixture phone is in the reserved 555-01xx range');
select is((select count(distinct private.demo_company(i)) from generate_series(1, 24) i), 24::bigint, '24 distinct fictional company names');
select is((select count(distinct private.demo_email(i)) from generate_series(1, 24) i), 24::bigint, '24 distinct fixture emails');
select is((select count(distinct private.demo_phone(i)) from generate_series(1, 24) i), 24::bigint, '24 distinct fixture phones');
select is((select count(distinct private.demo_person(i)) from generate_series(1, 24) i), 24::bigint, '24 distinct fictional people');
select is(private.demo_email(1), private.demo_email(25), 'the fixtures wrap deterministically after 24');
select is((select count(*) from generate_series(1, 48) i where private.demo_email(i) is null or private.demo_company(i) is null or private.demo_person(i) = ''), 0::bigint, 'no fixture is empty');
select is((select count(*) from generate_series(1, 24) i where private.demo_company(i) ~* '(google|apple|amazon|microsoft|facebook|walmart|ibm|netflix|tesla|nike|ford|disney)'), 0::bigint, 'no fixture company is a well-known real brand');
select is((select count(*) from generate_series(1, 24) i where private.demo_person(i) ~* '(trump|biden|obama|musk|gates|bezos|swift|smith|jones|johnson)'), 0::bigint, 'no fixture person is a famous or very common real name');
select is(private.demo_ts(1, 9), date_trunc('day', now()) - interval '1 day' + interval '9 hours', 'demo_ts(1) is yesterday at 09:00');
select ok(private.demo_ts(0, 23) <= now() - interval '5 minutes' and private.demo_ts(0, 0) <= now() - interval '5 minutes', 'demo_ts(0) is never in the future, whatever the hour');
select is(private.demo_ts(90, 9), date_trunc('day', now()) - interval '90 days' + interval '9 hours', 'demo_ts(90) is 90 days earlier');
select ok((select bool_and(private.demo_ts(d) <= now() and private.demo_ts(d) >= now() - interval '91 days') from generate_series(0, 90) d), 'offsets of 0 to 90 days stay in the past 90 days');
select is(private.demo_ts(10, 9), private.demo_ts(10, 9), 'demo_ts is stable within a transaction');

-- ---------------------------------------------------------------------------------------------
-- Registry and runner, with two probe seeders registered out of order
-- ---------------------------------------------------------------------------------------------
create table public.zz_seed_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null, kind text not null, n integer not null, label text not null, email text not null, phone text not null, happened_at timestamptz not null, step integer);
create sequence public.zz_seed_steps;
create function private.zz_seed_children(org uuid) returns void language plpgsql as $$
begin
  insert into public.zz_seed_probe (org_id, kind, n, label, email, phone, happened_at, step)
  select org, 'child', i, 'Task ' || i || ' for ' || private.demo_company(i), private.demo_email(i), private.demo_phone(i), private.demo_ts((i * 4) % 90, 10), nextval('public.zz_seed_steps')
  from generate_series(1, 6) i;
end $$;
create function private.zz_seed_parents(org uuid) returns void language plpgsql as $$
begin
  insert into public.zz_seed_probe (org_id, kind, n, label, email, phone, happened_at, step)
  select org, 'parent', i, private.demo_company(i), private.demo_email(i), private.demo_phone(i), private.demo_ts((i * 9) % 90), nextval('public.zz_seed_steps')
  from generate_series(1, 4) i;
end $$;

select is(private.demo_seed_version(), 1, 'with no seeders the seed version is the framework version (1)');
-- Registering only requires one call per entity; positions decide the order, not the registration order
select lives_ok($$select private.register_demo_seeder('zz_children', 20, 'private.zz_seed_children(uuid)'::regprocedure)$$, 'a seeder is added with one registration call');
select lives_ok($$select private.register_demo_seeder('zz_parents', 10, 'private.zz_seed_parents(uuid)'::regprocedure)$$, 'a second seeder, registered after');
select is(private.demo_seed_version(), 3, 'the seed version counts each registered seeder');
select lives_ok($$select private.register_demo_seeder('zz_parents', 10, 'private.zz_seed_parents(uuid)'::regprocedure, 1)$$, 're-registering the same seeder is safe');
select throws_ok($$select private.register_demo_seeder('zz_other', 10, 'private.zz_seed_parents(uuid)'::regprocedure)$$, '23505', null, 'two seeders cannot share a position');
select throws_ok($$select private.register_demo_seeder('Bad Name', 99, 'private.zz_seed_parents(uuid)'::regprocedure)$$, '23514', null, 'a seeder name must be a plain identifier');

select lives_ok($$select private.seed_demo_workspace('d1000000-0000-0000-0000-0000000000d1')$$, 'a demo workspace seeds');
select is((select count(*) from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1'), 10::bigint, 'every registered seeder ran (4 parents + 6 children)');
select ok((select max(step) filter (where kind = 'parent') < min(step) filter (where kind = 'child') from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1'), 'seeders ran in position order: parents before children');
select is((select seed_version from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 3, 'the seed version is recorded');
select ok((select seeded_at is not null from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 'and the seed time');

-- Idempotent: a second call changes nothing
select lives_ok($$select private.seed_demo_workspace('d1000000-0000-0000-0000-0000000000d1')$$, 'seeding again does not fail');
select is((select count(*) from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1'), 10::bigint, 'and adds no duplicate rows');

-- Determinism: a second workspace gets identical content with different ids
select lives_ok($$select private.seed_demo_workspace('d2000000-0000-0000-0000-0000000000d2')$$, 'a second workspace seeds');
select is(
  (select md5(string_agg(kind || '|' || n || '|' || label || '|' || email || '|' || phone || '|' || happened_at::text, E'\n' order by kind, n)) from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1'),
  (select md5(string_agg(kind || '|' || n || '|' || label || '|' || email || '|' || phone || '|' || happened_at::text, E'\n' order by kind, n)) from public.zz_seed_probe where org_id = 'd2000000-0000-0000-0000-0000000000d2'),
  'two workspaces get byte-identical content');
select is((select count(*) from public.zz_seed_probe a join public.zz_seed_probe b on a.id = b.id and a.org_id <> b.org_id), 0::bigint, 'with different record ids');
select is((select count(distinct id) from public.zz_seed_probe), 20::bigint, 'all 20 rows have distinct ids');

-- Reset: empty the data, clear the marker, seed again => the same content again
create temp table before_reset as
  select kind, n, label, email, phone, happened_at from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1';
delete from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1';
select lives_ok($$select private.clear_demo_seed_marker('d1000000-0000-0000-0000-0000000000d1')$$, 'the seed marker can be cleared for a reset');
select is((select seed_version from public.demo_workspaces where organization_id = 'd1000000-0000-0000-0000-0000000000d1'), 0, 'the marker is cleared');
select lives_ok($$select private.seed_demo_workspace('d1000000-0000-0000-0000-0000000000d1')$$, 'and the workspace seeds again');
select is((select count(*) from (select kind, n, label, email, phone, happened_at from public.zz_seed_probe where org_id = 'd1000000-0000-0000-0000-0000000000d1' except select * from before_reset) d), 0::bigint, 'a re-seed after emptying restores exactly the same content');
select is((select count(*) from before_reset), 10::bigint, '(the comparison set is the full 10 rows)');

-- Fiction rules hold for what the probe wrote through the fixtures
select is((select count(*) from public.zz_seed_probe where email !~ '@example\.com$' or phone !~ '^\(202\) 555-01[0-9]{2}$'), 0::bigint, 'no seeded value looks like a real email or phone');
select ok((select bool_and(happened_at between now() - interval '91 days' and now()) from public.zz_seed_probe), 'seeded dates fall in the past 90 days');

-- ---------------------------------------------------------------------------------------------
-- Safety: only valid demo workspaces, atomic, closed to browser roles
-- ---------------------------------------------------------------------------------------------
select throws_ok($$select private.seed_demo_workspace('a0000000-0000-0000-0000-00000000000a')$$, 'OD403', 'Only demo workspaces can be seeded.', 'a real organization can never be seeded');
select throws_ok($$select private.seed_demo_workspace('00000000-0000-0000-0000-000000000000')$$, 'OD404', 'That demo workspace was not found.', 'an unknown organization is refused');
select throws_ok($$select private.seed_demo_workspace('d3000000-0000-0000-0000-0000000000d3')$$, 'OD404', 'That demo workspace was not found.', 'a demo with no workspace registration is refused');
select is((select count(*) from public.zz_seed_probe where org_id = 'd3000000-0000-0000-0000-0000000000d3'), 0::bigint, 'and nothing was written for it');

create function private.zz_seed_boom(org uuid) returns void language plpgsql as $$
begin
  insert into public.zz_seed_probe (org_id, kind, n, label, email, phone, happened_at) values (org, 'boom', 1, 'x', 'x@example.com', '(202) 555-0100', now());
  raise exception 'seeder failed';
end $$;
select private.register_demo_seeder('zz_boom', 30, 'private.zz_seed_boom(uuid)'::regprocedure);
select private.clear_demo_seed_marker('d2000000-0000-0000-0000-0000000000d2');
delete from public.zz_seed_probe where org_id = 'd2000000-0000-0000-0000-0000000000d2';
select throws_ok($$select private.seed_demo_workspace('d2000000-0000-0000-0000-0000000000d2')$$, 'P0001', 'seeder failed', 'a failing seeder fails the whole seed');
select is((select count(*) from public.zz_seed_probe where org_id = 'd2000000-0000-0000-0000-0000000000d2'), 0::bigint, 'and nothing it or earlier seeders wrote is kept (atomic)');
select is((select seed_version from public.demo_workspaces where organization_id = 'd2000000-0000-0000-0000-0000000000d2'), 0, 'the marker stays unset after a failed seed');
delete from private.demo_seeders where name = 'zz_boom';

select ok(
  not has_function_privilege('authenticated', 'private.seed_demo_workspace(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.seed_demo_workspace(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.clear_demo_seed_marker(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.register_demo_seeder(text, integer, regprocedure, integer, regprocedure)', 'execute')
  and not has_function_privilege('authenticated', 'private.demo_email(integer)', 'execute')
  and has_function_privilege('service_role', 'private.seed_demo_workspace(uuid)', 'execute'),
  'browser roles cannot run the seeder or the fixtures; service_role can');
select ok(not has_table_privilege('authenticated', 'private.demo_seeders', 'select') and not has_table_privilege('anon', 'private.demo_seeders', 'select'), 'the registry table has no client privileges');
select ok((select prosecdef and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'private.seed_demo_workspace(uuid)'::regprocedure), 'the runner is SECURITY DEFINER with a pinned search_path');

select * from finish();
rollback;
