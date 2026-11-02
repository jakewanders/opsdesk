-- Cross-tenant negative tests for the tenancy tables (SIT-197, PRD 11.2). Built on the shared fixtures in
-- 000-test-helpers.test.sql: org A and org B each have an owner, admin, member and viewer; G1 and G2 are guests.
begin;
select plan(47);
select tests.create_fixtures();

-- A statement templates, parameterized by the target tenant
create temp table ctx as select
  tests.org_id('a') as a, tests.org_id('b') as b,
  array['a_owner','a_admin','a_member','a_viewer'] as a_users,
  array['b_owner','b_admin','b_member','b_viewer'] as b_users;

-- =============================================================================================
-- 1. A member of one org cannot select, update or delete anything in the other (every role, both directions)
-- =============================================================================================
-- select
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where tests.visible_count_as(u, 'public.organizations', format('id = %L', tests.org_id('b'))) > 0), 0::bigint, 'no org A user can read organization B');
select is((select count(*) from unnest(array['b_owner','b_admin','b_member','b_viewer']) u where tests.visible_count_as(u, 'public.organizations', format('id = %L', tests.org_id('a'))) > 0), 0::bigint, 'no org B user can read organization A');
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where tests.visible_count_as(u, 'public.memberships', format('organization_id = %L', tests.org_id('b'))) > 0), 0::bigint, 'no org A user can read org B memberships');
select is((select count(*) from unnest(array['b_owner','b_admin','b_member','b_viewer']) u where tests.visible_count_as(u, 'public.memberships', format('organization_id = %L', tests.org_id('a'))) > 0), 0::bigint, 'no org B user can read org A memberships');
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where tests.visible_count_as(u, 'public.profiles', format('id = any (%L::uuid[])', array[tests.uid('b_owner'), tests.uid('b_admin'), tests.uid('b_member'), tests.uid('b_viewer')])) > 0), 0::bigint, 'no org A user can read an org B profile');
select is((select count(*) from unnest(array['b_owner','b_admin','b_member','b_viewer']) u where tests.visible_count_as(u, 'public.profiles', format('id <> %L', tests.uid(u))) > 0), 0::bigint, 'nobody reads anyone else''s profile, even in their own org');
select is(tests.visible_count_as('a_viewer', 'public.organizations'), 1::bigint, 'a viewer sees exactly one organization');
select is(tests.visible_count_as('a_viewer', 'public.memberships'), 4::bigint, 'and exactly their org''s four memberships');
select is(tests.visible_count_as('g1', 'public.organizations'), 1::bigint, 'a guest sees only their own demo');
select is(tests.visible_count_as('g1', 'public.organizations', format('id = %L', tests.org_id('g2'))), 0::bigint, 'G1 cannot see G2''s demo');
select is(tests.visible_count_as('g2', 'public.organizations', format('id = %L', tests.org_id('g1'))), 0::bigint, 'G2 cannot see G1''s demo');
select is(tests.visible_count_as('g1', 'public.organizations', format('id = %L', tests.org_id('a'))), 0::bigint, 'a guest cannot see a real tenant');
select is(tests.visible_count_as('a_owner', 'public.organizations', format('id = %L', tests.org_id('g1'))), 0::bigint, 'and a real tenant cannot see a guest''s demo');
select is(tests.visible_count_as('outsider', 'public.organizations'), 0::bigint, 'a user in no organization sees none');

-- update (RLS filters the rows: 0 changed, no error)
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where tests.rows_changed_as(u, format('update public.organizations set name = %L where id = %L', 'hacked', tests.org_id('b'))) <> 0), 0::bigint, 'no org A user can update organization B (even the owner)');
select is((select count(*) from unnest(array['b_owner','b_admin','b_member','b_viewer']) u where tests.rows_changed_as(u, format('update public.organizations set name = %L where id = %L', 'hacked', tests.org_id('a'))) <> 0), 0::bigint, 'no org B user can update organization A');
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where tests.rows_changed_as(u, format('update public.profiles set display_name = %L where id = %L', 'hacked', tests.uid('b_owner'))) <> 0), 0::bigint, 'no org A user can rewrite an org B profile');
select is((select count(*) from unnest(array['g1','g2']) u where tests.rows_changed_as(u, format('update public.organizations set name = %L', 'hacked')) <> 0), 0::bigint, 'guests cannot edit any organization (own demo included)');
select is(tests.rows_changed_as('g3', format('update public.organizations set name = %L', 'x')), 0::bigint, 'nor can the guest of an expired demo');
select is((select string_agg(name, ',' order by name) from public.organizations where id in (tests.org_id('a'), tests.org_id('b'))), 'Org A,Org B', 'no cross-tenant write took effect');

-- delete: no client DELETE grant on any tenancy table
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where not tests.denied_as(u, format('delete from public.organizations where id = %L', tests.org_id('b')))), 0::bigint, 'no org A user can delete organization B');
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where not tests.denied_as(u, format('delete from public.memberships where organization_id = %L', tests.org_id('b')))), 0::bigint, 'nor delete org B memberships');
select is((select count(*) from unnest(array['a_owner','a_admin','a_member','a_viewer']) u where not tests.denied_as(u, format('delete from public.profiles where id = %L', tests.uid('b_owner')))), 0::bigint, 'nor delete an org B profile');
select is((select count(*) from unnest(array['a_owner','a_viewer']) u where not tests.denied_as(u, format('delete from public.organizations where id = %L', tests.org_id('a')))), 0::bigint, 'and an owner cannot delete their own organization either');
select is((select count(*) from public.organizations) + (select count(*) from public.memberships) * 100, 5::bigint + 11 * 100, 'nothing was deleted');

-- =============================================================================================
-- 2. Nobody writes memberships directly
-- =============================================================================================
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', tests.org_id('a'), tests.uid('outsider'), 'viewer'))), 0::bigint, 'no user can insert a membership (not even an owner adding someone)');
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', tests.org_id('b'), tests.uid(u), 'owner'))), 0::bigint, 'nor add themselves to another org as owner');
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('update public.memberships set role = %L', 'owner'))), 0::bigint, 'no user can update a membership role');
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, 'delete from public.memberships')), 0::bigint, 'no user can delete a membership');
select is((select count(*) from unnest(array['g1','g2']) u where not tests.denied_as(u, format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, %L)', tests.org_id('a'), tests.uid(u), 'owner'))), 0::bigint, 'a guest cannot join a real tenant');

-- =============================================================================================
-- 3. Nobody changes their own role, or an org's kind / expiry
-- =============================================================================================
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('update public.memberships set role = %L where user_id = %L', 'owner', tests.uid(u)))), 0::bigint, 'no user can promote themselves');
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('update public.organizations set kind = %L', 'demo'))), 0::bigint, 'no user can change an organization''s kind');
select is((select count(*) from unnest(tests.real_users()) u where not tests.denied_as(u, format('update public.organizations set expires_at = %L', now() + interval '1 year'))), 0::bigint, 'no user can set an expiry on a real organization');
select is((select count(*) from unnest(array['g1','g2']) u where not tests.denied_as(u, format('update public.organizations set expires_at = %L', now() + interval '1 year'))), 0::bigint, 'a guest cannot extend their demo');
select is((select count(*) from unnest(array['g1','g2']) u where not tests.denied_as(u, format('update public.organizations set kind = %L', 'real'))), 0::bigint, 'nor turn it into a real organization');
select is((select count(*) from unnest(array['a_owner','b_owner']) u where not tests.denied_as(u, format('update public.organizations set created_by = %L', tests.uid(u)))), 0::bigint, 'nor reassign created_by');
select is((select count(*) from unnest(array['a_owner','b_owner']) u where not tests.denied_as(u, format('insert into public.organizations (name) values (%L)', 'Sneaky'))), 0::bigint, 'nor create an organization directly');

-- =============================================================================================
-- 4. The anon key reads nothing, anywhere
-- =============================================================================================
select is((select count(*) from tests.public_tables() t where not tests.denied_as_anon(format('select * from %s', t))), 0::bigint, 'anon cannot select from ANY table in public');
select is((select count(*) from tests.public_tables() t where not tests.denied_as_anon(format('insert into %s default values', t)) ), 0::bigint, 'anon cannot insert into any table in public');
select is((select count(*) from tests.public_tables() t where not tests.denied_as_anon(format('delete from %s', t))), 0::bigint, 'anon cannot delete from any table in public');
select ok(tests.denied_as_anon('select private.is_member(tests.org_id(''a''))'), 'anon cannot call the RLS helpers');

-- =============================================================================================
-- 5. Catalog guards (hold for every table and function added later)
-- =============================================================================================
select is((select count(*) from tests.public_tables() t where not (select relrowsecurity from pg_class where oid = t)), 0::bigint, 'every public table has RLS enabled');
select is((select count(*) from tests.public_tables() t cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) p where has_table_privilege('anon', t, p)), 0::bigint, 'anon holds no privilege on any public table');
select is((select count(*) from tests.public_tables() t cross join unnest(array['insert','delete','truncate']) p where has_table_privilege('authenticated', t, p)), 0::bigint, 'authenticated holds no insert, delete or truncate on any public table');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', '), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef and not coalesce('search_path=""' = any (p.proconfig), false)),
  '', 'every SECURITY DEFINER function in public and private pins an empty search_path');
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', '), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.proname <> 'health_ping' /* the no-data liveness probe, SIT-186 */ and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))),
  '', 'no function in public or private is executable by anon or PUBLIC (except the health_ping probe)');
select is((select count(*) from tests.public_tables() t where t::text in ('profiles', 'organizations', 'memberships', 'demo_workspaces')), 4::bigint, 'the tenancy tables are the ones under test (update this list when a table is added)');

select * from finish();
rollback;
