-- Shared pgTAP helpers and fixtures (SIT-197). Runs first (alphabetical order) and commits the helper functions, so every later
-- test file can call tests.* without copy/paste. The `tests` schema exists only in the local/CI test database:
-- no migration creates it, `supabase test db` re-creates it on every run, and `db:reset` removes it.
-- Usage and conventions: supabase/tests/README.md.
begin;

create schema if not exists tests;

-- ---------------------------------------------------------------------------------------------
-- Deterministic identities (readable UUIDs: the prefix says who)
-- ---------------------------------------------------------------------------------------------
-- users:   a_owner a_admin a_member a_viewer   (real, org A)      b_owner b_admin b_member b_viewer (real, org B)
--          g1 g2 (anonymous guests, each owns a live demo)         outsider (real, no organization)
-- orgs:    a  b  (real)   g1  g2 (demo, owned by the guest of the same name)   expired (demo, already expired; owner g3)
create or replace function tests.uid(label text) returns uuid language sql immutable set search_path = '' as $$
  select (case label
    when 'a_owner'  then 'a1000000-0000-4000-8000-000000000001'
    when 'a_admin'  then 'a2000000-0000-4000-8000-000000000002'
    when 'a_member' then 'a3000000-0000-4000-8000-000000000003'
    when 'a_viewer' then 'a4000000-0000-4000-8000-000000000004'
    when 'b_owner'  then 'b1000000-0000-4000-8000-000000000001'
    when 'b_admin'  then 'b2000000-0000-4000-8000-000000000002'
    when 'b_member' then 'b3000000-0000-4000-8000-000000000003'
    when 'b_viewer' then 'b4000000-0000-4000-8000-000000000004'
    when 'g1'       then '91000000-0000-4000-8000-000000000001'
    when 'g2'       then '92000000-0000-4000-8000-000000000002'
    when 'g3'       then '93000000-0000-4000-8000-000000000003'
    when 'outsider' then 'c0000000-0000-4000-8000-000000000000'
  end)::uuid
$$;

create or replace function tests.org_id(label text) returns uuid language sql immutable set search_path = '' as $$
  select (case label
    when 'a'       then 'a0000000-0000-4000-8000-00000000000a'
    when 'b'       then 'b0000000-0000-4000-8000-00000000000b'
    when 'g1'      then '91000000-0000-4000-8000-0000000000d1'
    when 'g2'      then '92000000-0000-4000-8000-0000000000d2'
    when 'expired' then '93000000-0000-4000-8000-0000000000d3'
  end)::uuid
$$;

-- ---------------------------------------------------------------------------------------------
-- Fixtures: call once at the top of a test file (inside its transaction)
-- ---------------------------------------------------------------------------------------------
create or replace function tests.create_fixtures() returns void language plpgsql set search_path = '' as $$
declare
  r record;
begin
  for r in select * from (values
      ('a_owner', false), ('a_admin', false), ('a_member', false), ('a_viewer', false),
      ('b_owner', false), ('b_admin', false), ('b_member', false), ('b_viewer', false),
      ('outsider', false), ('g1', true), ('g2', true), ('g3', true)) as v(label, anon) loop
    insert into auth.users (id, email, is_anonymous)
    values (tests.uid(r.label), case when r.anon then null else r.label || '@example.test' end, r.anon);
  end loop;

  insert into public.organizations (id, name, kind, expires_at, created_by) values
    (tests.org_id('a'), 'Org A', 'real', null, tests.uid('a_owner')),
    (tests.org_id('b'), 'Org B', 'real', null, tests.uid('b_owner')),
    (tests.org_id('g1'), 'Demo G1', 'demo', now() + interval '24 hours', tests.uid('g1')),
    (tests.org_id('g2'), 'Demo G2', 'demo', now() + interval '24 hours', tests.uid('g2')),
    (tests.org_id('expired'), 'Demo expired', 'demo', now() + interval '24 hours', tests.uid('g3'));
  -- trusted path: the postgres role may set the past expiry
  update public.organizations set expires_at = now() - interval '1 minute' where id = tests.org_id('expired');

  insert into public.memberships (organization_id, user_id, role) values
    (tests.org_id('a'), tests.uid('a_owner'), 'owner'),   (tests.org_id('a'), tests.uid('a_admin'), 'admin'),
    (tests.org_id('a'), tests.uid('a_member'), 'member'), (tests.org_id('a'), tests.uid('a_viewer'), 'viewer'),
    (tests.org_id('b'), tests.uid('b_owner'), 'owner'),   (tests.org_id('b'), tests.uid('b_admin'), 'admin'),
    (tests.org_id('b'), tests.uid('b_member'), 'member'), (tests.org_id('b'), tests.uid('b_viewer'), 'viewer'),
    (tests.org_id('g1'), tests.uid('g1'), 'owner'), (tests.org_id('g2'), tests.uid('g2'), 'owner'),
    (tests.org_id('expired'), tests.uid('g3'), 'owner');

  perform private.register_demo_workspace(tests.org_id('g1'), tests.uid('g1'));
  perform private.register_demo_workspace(tests.org_id('g2'), tests.uid('g2'));
  perform private.register_demo_workspace(tests.org_id('expired'), tests.uid('g3'));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Acting as someone. Always pair with tests.reset(). Changes are local to the transaction.
-- ---------------------------------------------------------------------------------------------
-- As a fixture user: authenticated role, JWT sub = the user, is_anonymous = true for g1/g2/g3.
create or replace function tests.act_as(label text) returns void language plpgsql as $$
begin
  perform tests.act_as_uid(tests.uid(label), label like 'g%');
end $$;

-- As an arbitrary user id (use when a test creates its own users).
create or replace function tests.act_as_uid(uid uuid, anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'is_anonymous', anonymous)::text, true);
  set local role authenticated;
end $$;

-- As an arbitrary Postgres role with explicit claims, for service_role or a forged claim.
create or replace function tests.act_as_role(role_name text, uid uuid default null, anonymous boolean default false) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', role_name, 'is_anonymous', anonymous)::text, true);
  execute format('set local role %I', role_name);
end $$;

-- As the public (anon) key: no user.
create or replace function tests.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
end $$;

-- As the server's service key.
create or replace function tests.act_as_service() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
end $$;

-- Back to the test runner (postgres), clearing the claims.
create or replace function tests.reset() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------------------------------------------------------------------------------------------
-- Assertions helpers
-- ---------------------------------------------------------------------------------------------
-- Runs a data-changing statement and returns how many rows it changed. RLS hides rows silently, so a denied
-- UPDATE or DELETE changes 0 rows instead of raising: assert the count, not an error.
create or replace function tests.rows_changed(stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  return n;
end $$;

-- True when the statement is refused with "permission denied" (SQLSTATE 42501): a missing grant or a failed RLS check.
create or replace function tests.denied(stmt text) returns boolean language plpgsql as $$
begin
  execute stmt;
  return false;
exception when insufficient_privilege then
  return true;
end $$;

-- The SQLSTATE a statement fails with, or 'ok' if it succeeds. Handy for exact-code assertions.
create or replace function tests.sqlstate_of(stmt text) returns text language plpgsql as $$
begin
  execute stmt;
  return 'ok';
exception when others then
  return sqlstate;
end $$;

-- The plan text of a query, for index-use assertions.
create or replace function tests.explain_text(q text) returns text language plpgsql as $$
declare r record; out text := '';
begin
  for r in execute 'explain ' || q loop out := out || (r."QUERY PLAN") || E'\n'; end loop;
  return out;
end $$;

-- Row count of a table as the current role sees it (RLS applies).
create or replace function tests.visible_count(tbl regclass, where_sql text default 'true') returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from %s where %s', tbl, where_sql) into n;
  return n;
end $$;

-- Every table in public, as text, for catalog-style loops.
create or replace function tests.public_tables() returns setof regclass language sql stable as $$
  select c.oid::regclass from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') order by c.relname
$$;


-- One-shot "as this user" forms: act, run, reset, all inside the function, so they work in a set-returning loop
-- such as `select count(*) from unnest(array['a_owner','a_viewer']) l where tests.denied_as(l, ...)`.
create or replace function tests.rows_changed_as(label text, stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform tests.act_as(label);
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when others then
    perform tests.reset();
    raise;
  end;
  perform tests.reset();
  return n;
end $$;

create or replace function tests.denied_as(label text, stmt text) returns boolean language plpgsql as $$
declare refused boolean := false;
begin
  perform tests.act_as(label);
  begin
    execute stmt;
  exception when insufficient_privilege then
    refused := true;
  end;
  perform tests.reset();
  return refused;
end $$;

create or replace function tests.visible_count_as(label text, tbl regclass, where_sql text default 'true') returns bigint language plpgsql as $$
declare n bigint;
begin
  perform tests.act_as(label);
  execute format('select count(*) from %s where %s', tbl, where_sql) into n;
  perform tests.reset();
  return n;
end $$;

create or replace function tests.denied_as_anon(stmt text) returns boolean language plpgsql as $$
declare refused boolean := false;
begin
  perform tests.act_as_anon();
  begin
    execute stmt;
  exception when insufficient_privilege then
    refused := true;
  end;
  perform tests.reset();
  return refused;
end $$;

-- All eight real fixture users, for loops.
create or replace function tests.real_users() returns text[] language sql immutable as $$
  select array['a_owner','a_admin','a_member','a_viewer','b_owner','b_admin','b_member','b_viewer']
$$;

grant usage on schema tests to public;
grant execute on all functions in schema tests to public;
-- The functions are committed here; the self-test below runs in its own transaction and rolls back its fixtures.
commit;

begin;
select plan(31);

-- ---------------------------------------------------------------------------------------------
-- The helpers test themselves
-- ---------------------------------------------------------------------------------------------
select is(tests.uid('a_owner'), 'a1000000-0000-4000-8000-000000000001'::uuid, 'uid returns a readable deterministic id');
select is(tests.uid('nobody'), null::uuid, 'an unknown label is null, never a surprise user');
select is(tests.org_id('a'), 'a0000000-0000-4000-8000-00000000000a'::uuid, 'org_id returns a deterministic id');

select tests.create_fixtures();
select is((select count(*) from auth.users where id in (select tests.uid(l) from unnest(array['a_owner','a_admin','a_member','a_viewer','b_owner','b_admin','b_member','b_viewer','outsider','g1','g2','g3']) l)), 12::bigint, 'fixtures create 12 users');
select is((select count(*) from auth.users where is_anonymous), 3::bigint, 'three of them anonymous guests');
select is((select count(*) from public.organizations), 5::bigint, 'and five organizations (a, b, g1, g2, expired)');
select is((select string_agg(role, ',' order by role) from public.memberships where organization_id = tests.org_id('a')), 'admin,member,owner,viewer', 'org A has all four roles');
select is((select count(*) from public.demo_workspaces), 3::bigint, 'the three demos are registered');
select is((select count(*) from public.profiles), 12::bigint, 'the profile trigger created a profile per user');
select ok((select expires_at < now() from public.organizations where id = tests.org_id('expired')), 'the expired demo is in the past');

select tests.act_as('a_member');
select is(auth.uid(), tests.uid('a_member'), 'act_as sets auth.uid()');
select is(private.is_anonymous(), false, 'a real user is not anonymous');
select is(current_user::text, 'authenticated', 'act_as switches to the authenticated role');
select is((select count(*) from public.organizations), 1::bigint, 'and RLS applies');
select tests.reset();
select is(current_user::text, 'postgres', 'reset returns to the runner role');
select is(coalesce(auth.uid()::text, 'none'), 'none', 'and clears the identity');

select tests.act_as('g1');
select is(private.is_anonymous(), true, 'a guest label sets is_anonymous');
select tests.reset();
select tests.act_as_anon();
select is(current_user::text, 'anon', 'act_as_anon switches to anon');
select ok(tests.denied('select * from public.organizations'), 'denied() reports a permission error');
select tests.reset();
select tests.act_as_service();
select is(current_user::text, 'service_role', 'act_as_service switches to service_role');
select tests.reset();
select tests.act_as('a_owner');
select is(tests.rows_changed($$update public.organizations set name = 'Org A' where id = tests.org_id('b')$$), 0::bigint, 'rows_changed counts RLS-filtered updates as 0');
select is(tests.sqlstate_of('select 1'), 'ok', 'sqlstate_of reports ok');
select is(tests.sqlstate_of($$update public.organizations set kind = 'demo'$$), '42501', 'and the exact SQLSTATE of a failure');
select tests.reset();
select ok(position('organizations_pkey' in tests.explain_text($$select * from public.organizations where id = tests.org_id('a')$$)) >= 0, 'explain_text returns plan text');
select is((select count(*) from tests.public_tables()), (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')), 'public_tables lists every table');
select is(tests.visible_count('public.memberships', $$role = 'owner'$$), 5::bigint, 'visible_count counts rows');

select is(tests.rows_changed_as('a_owner', $$update public.organizations set name = 'Org A' where id = tests.org_id('b')$$), 0::bigint, 'rows_changed_as acts, counts and resets');
select is(current_user::text, 'postgres', 'and leaves the runner role in place');
select is(tests.denied_as('a_viewer', $$delete from public.memberships$$), true, 'denied_as reports a refused statement for a user');
select is(tests.visible_count_as('b_viewer', 'public.organizations'), 1::bigint, 'visible_count_as counts what that user sees');
select is(tests.denied_as_anon('select * from public.profiles'), true, 'denied_as_anon reports a refused statement for the anon key');

select * from finish();
rollback;
