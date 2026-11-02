-- pgTAP tests for the tenancy RLS policies and restrictive grants (SIT-194).
-- Actors (PRD 11.2): org A (real): A1 owner, A2 admin, A3 member, A4 viewer; org B (real): B1 owner;
-- anonymous guests G1 and G2 with their own live demos; G3 an anonymous guest whose demo has expired.
begin;
select plan(60);

insert into auth.users (id, email, is_anonymous) values
  ('a1000000-0000-0000-0000-000000000001', 'a1@example.com', false),
  ('a2000000-0000-0000-0000-000000000002', 'a2@example.com', false),
  ('a3000000-0000-0000-0000-000000000003', 'a3@example.com', false),
  ('a4000000-0000-0000-0000-000000000004', 'a4@example.com', false),
  ('b1000000-0000-0000-0000-000000000001', 'b1@example.com', false),
  ('91000000-0000-0000-0000-000000000001', null, true),
  ('92000000-0000-0000-0000-000000000002', null, true),
  ('93000000-0000-0000-0000-000000000003', null, true);

insert into public.organizations (id, name, industry, kind, expires_at) values
  ('a0000000-0000-0000-0000-00000000000a', 'Org A', 'plumbing', 'real', null),
  ('b0000000-0000-0000-0000-00000000000b', 'Org B', 'roofing', 'real', null),
  ('91000000-0000-0000-0000-0000000000d1', 'Demo G1', null, 'demo', now() + interval '1 hour'),
  ('92000000-0000-0000-0000-0000000000d2', 'Demo G2', null, 'demo', now() + interval '1 hour'),
  ('93000000-0000-0000-0000-0000000000d3', 'Demo G3', null, 'demo', now() + interval '1 hour');
update public.organizations set expires_at = now() - interval '1 minute' where id = '93000000-0000-0000-0000-0000000000d3';
insert into public.memberships (organization_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('a0000000-0000-0000-0000-00000000000a', 'a2000000-0000-0000-0000-000000000002', 'admin'),
  ('a0000000-0000-0000-0000-00000000000a', 'a3000000-0000-0000-0000-000000000003', 'member'),
  ('a0000000-0000-0000-0000-00000000000a', 'a4000000-0000-0000-0000-000000000004', 'viewer'),
  ('b0000000-0000-0000-0000-00000000000b', 'b1000000-0000-0000-0000-000000000001', 'owner'),
  ('91000000-0000-0000-0000-0000000000d1', '91000000-0000-0000-0000-000000000001', 'owner'),
  ('92000000-0000-0000-0000-0000000000d2', '92000000-0000-0000-0000-000000000002', 'owner'),
  ('93000000-0000-0000-0000-0000000000d3', '93000000-0000-0000-0000-000000000003', 'owner');


-- Count rows an UPDATE changed (RLS filters rows silently; the count proves it)

-- =============================================================================================
-- Catalog tests: the defaults are inverted and every table is protected
-- =============================================================================================
select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  '', 'every table in public has row level security enabled'
);
select is(
  (select coalesce(string_agg(c.relname || ':' || p, ', ' order by c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) p
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
      and has_table_privilege('anon', c.oid, p)),
  '', 'anon holds no privilege on any table or view in public'
);
select is(
  (select coalesce(string_agg(c.relname || '.' || a.attname, ', '), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     cross join unnest(array['select','insert','update','references']) p
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and has_column_privilege('anon', c.oid, a.attnum, p)),
  '', 'anon holds no column privilege either'
);
select is(
  (select coalesce(string_agg(c.relname || ':' || p, ', ' order by c.relname, p), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     cross join unnest(array['insert','delete','truncate','references','trigger']) p
    where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege('authenticated', c.oid, p) and not (p = 'insert' and c.relname in ('customers', 'opportunities', 'tasks'))),
  '', 'authenticated holds no insert, delete, truncate, references or trigger privilege on any table (insert only on entity tables)'
);
select is(
  (select coalesce(string_agg(c.relname || '.' || a.attname, ', ' order by c.relname, a.attname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname not in ('customers', 'opportunities', 'tasks') and has_column_privilege('authenticated', c.oid, a.attnum, 'update')),
  'organizations.industry, organizations.name, organizations.timezone, profiles.avatar_url, profiles.display_name',
  'the only columns an API user may update are the approved settings and profile fields (entity tables are covered by their own tests)'
);
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', '), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname <> 'health_ping' /* the no-data liveness probe, SIT-186 */ and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))),
  '', 'no function in public is executable by anon or PUBLIC (except the health_ping probe)'
);
select ok(not has_schema_privilege('anon', 'private', 'usage') and not has_schema_privilege('authenticated', 'public', 'create') and not has_schema_privilege('anon', 'public', 'create'),
  'anon cannot use the private schema and nobody can create objects in public');
select ok(
  (select count(*) from pg_default_acl d where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = 'r'
     and exists (select 1 from aclexplode(d.defaclacl) a where a.grantee in ('anon'::regrole, 'authenticated'::regrole))) = 0,
  'default privileges give new tables no access to anon or authenticated'
);
-- A table created by the migration role afterwards really starts closed
create table public.zz_default_probe (id int);
select ok(
  not has_table_privilege('anon', 'public.zz_default_probe', 'select')
  and not has_table_privilege('authenticated', 'public.zz_default_probe', 'select')
  and not has_table_privilege('authenticated', 'public.zz_default_probe', 'insert'),
  'a table created now starts with no grants for anon or authenticated');
create function public.zz_default_fn() returns int language sql as 'select 1';
select ok(
  not has_function_privilege('anon', 'public.zz_default_fn()', 'execute')
  and not has_function_privilege('authenticated', 'public.zz_default_fn()', 'execute')
  and not has_function_privilege('public', 'public.zz_default_fn()', 'execute'),
  'a function created now is not executable by anon, authenticated or PUBLIC');

-- every restrictive denial exists
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'memberships' and permissive = 'RESTRICTIVE'),
  3::bigint, 'memberships carries explicit restrictive denials for insert, update and delete');

-- =============================================================================================
-- anon (the public key) gets nothing from any tenancy table
-- =============================================================================================
select tests.act_as_anon();
select throws_ok($$select * from public.organizations$$, '42501', null, 'anon cannot select organizations');
select throws_ok($$select * from public.memberships$$, '42501', null, 'anon cannot select memberships');
select throws_ok($$select * from public.profiles$$, '42501', null, 'anon cannot select profiles');
select throws_ok($$insert into public.organizations (name) values ('x')$$, '42501', null, 'anon cannot insert organizations');
select throws_ok($$update public.organizations set name = 'x'$$, '42501', null, 'anon cannot update organizations');
select throws_ok($$delete from public.memberships$$, '42501', null, 'anon cannot delete memberships');
select throws_ok($$select private.is_member('a0000000-0000-0000-0000-00000000000a')$$, '42501', null, 'anon cannot call the RLS helpers');
reset role;

-- =============================================================================================
-- organizations: read
-- =============================================================================================
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Org A')$$, 'A1 sees only org A');
select is((select count(*) from public.organizations where id = 'b0000000-0000-0000-0000-00000000000b'), 0::bigint, 'A1 cannot read org B by id');
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Org A')$$, 'A4 (viewer) can read their org');
select tests.act_as_uid('b1000000-0000-0000-0000-000000000001');
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Org B')$$, 'B1 sees only org B');
select tests.act_as_uid('91000000-0000-0000-0000-000000000001', true);
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Demo G1')$$, 'G1 sees only their own demo');
select tests.act_as_uid('92000000-0000-0000-0000-000000000002', true);
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Demo G2')$$, 'G2 sees only their own demo, not G1''s');
select tests.act_as_uid('93000000-0000-0000-0000-000000000003', true);
select results_eq($$select name::text from public.organizations order by name$$, $$values ('Demo G3')$$, 'G3 can still read their expired demo');
reset role;

-- =============================================================================================
-- organizations: update (owner/admin of a real org only)
-- =============================================================================================
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select is(tests.rows_changed($$update public.organizations set name = 'Org A (owner)', industry = 'hvac', timezone = 'America/Chicago' where id = 'a0000000-0000-0000-0000-00000000000a'$$), 1::bigint, 'owner can update name, industry and timezone');
select tests.act_as_uid('a2000000-0000-0000-0000-000000000002');
select is(tests.rows_changed($$update public.organizations set name = 'Org A (admin)' where id = 'a0000000-0000-0000-0000-00000000000a'$$), 1::bigint, 'admin can update settings');
select tests.act_as_uid('a3000000-0000-0000-0000-000000000003');
select is(tests.rows_changed($$update public.organizations set name = 'Hacked by member' where id = 'a0000000-0000-0000-0000-00000000000a'$$), 0::bigint, 'member cannot update (0 rows)');
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select is(tests.rows_changed($$update public.organizations set name = 'Hacked by viewer' where id = 'a0000000-0000-0000-0000-00000000000a'$$), 0::bigint, 'viewer cannot update (0 rows)');
select tests.act_as_uid('b1000000-0000-0000-0000-000000000001');
select is(tests.rows_changed($$update public.organizations set name = 'Hacked by B1' where id = 'a0000000-0000-0000-0000-00000000000a'$$), 0::bigint, 'the owner of org B cannot update org A');
select tests.act_as_uid('91000000-0000-0000-0000-000000000001', true);
select is(tests.rows_changed($$update public.organizations set name = 'Guest edit' where id = '91000000-0000-0000-0000-0000000000d1'$$), 0::bigint, 'a demo guest cannot edit organization settings, even on their own live demo');
select is(tests.rows_changed($$update public.organizations set name = 'Guest edit' where id = '92000000-0000-0000-0000-0000000000d2'$$), 0::bigint, 'nor another guest''s demo');
reset role;
select results_eq($$select name::text from public.organizations where id in ('a0000000-0000-0000-0000-00000000000a','b0000000-0000-0000-0000-00000000000b','91000000-0000-0000-0000-0000000000d1') order by id$$,
  $$values ('Demo G1'::text), ('Org A (admin)'), ('Org B')$$, 'the data is what the legitimate writers left');
-- an owner of an expired organization cannot write either
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select throws_ok($$update public.organizations set kind = 'demo' where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'owner cannot write kind (no column grant)');
select throws_ok($$update public.organizations set expires_at = now() + interval '1 year' where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'owner cannot write expires_at (no column grant)');
select throws_ok($$update public.organizations set created_by = 'a1000000-0000-0000-0000-000000000001' where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'owner cannot write created_by');
select throws_ok($$update public.organizations set id = gen_random_uuid() where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'owner cannot write id');
select throws_ok($$update public.organizations set slug = 'stolen' where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'owner cannot write slug (not an approved setting)');
select throws_ok($$update public.organizations set timezone = 'Mars/Base' where id = 'a0000000-0000-0000-0000-00000000000a'$$, '23514', null, 'an invalid timezone is still refused by the check constraint');
select throws_ok($$insert into public.organizations (name) values ('Sneaky Co')$$, '42501', null, 'an owner cannot insert an organization directly');
select throws_ok($$delete from public.organizations where id = 'a0000000-0000-0000-0000-00000000000a'$$, '42501', null, 'an owner cannot delete their organization');
reset role;

-- =============================================================================================
-- memberships: read-only
-- =============================================================================================
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select is((select count(*) from public.memberships), 4::bigint, 'a viewer sees all four memberships of their own org');
select is((select count(*) from public.memberships where organization_id = 'b0000000-0000-0000-0000-00000000000b'), 0::bigint, 'and none of org B');
select tests.act_as_uid('91000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.memberships), 1::bigint, 'G1 sees only their own membership');
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select throws_ok($$insert into public.memberships (organization_id, user_id, role) values ('a0000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-000000000001', 'owner')$$, '42501', null, 'an owner cannot insert memberships');
select throws_ok($$update public.memberships set role = 'owner' where user_id = 'a4000000-0000-0000-0000-000000000004'$$, '42501', null, 'an owner cannot change a role directly');
select throws_ok($$delete from public.memberships where user_id = 'a4000000-0000-0000-0000-000000000004'$$, '42501', null, 'an owner cannot remove a member directly');
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select throws_ok($$update public.memberships set role = 'owner' where user_id = 'a4000000-0000-0000-0000-000000000004'$$, '42501', null, 'a viewer cannot promote themselves');
select throws_ok($$insert into public.memberships (organization_id, user_id, role) values ('b0000000-0000-0000-0000-00000000000b', 'a4000000-0000-0000-0000-000000000004', 'owner')$$, '42501', null, 'a viewer cannot add themselves to org B');
reset role;
select is((select role from public.memberships where user_id = 'a4000000-0000-0000-0000-000000000004'), 'viewer', 'the viewer is still a viewer');
select is((select count(*) from public.memberships), 8::bigint, 'and no membership was added or removed');

-- Even if a future change granted write access, the restrictive policies still deny it
grant insert, update, delete on public.memberships to authenticated;
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select throws_ok($$insert into public.memberships (organization_id, user_id, role) values ('a0000000-0000-0000-0000-00000000000a', 'b1000000-0000-0000-0000-000000000001', 'owner')$$, '42501', null, 'restrictive policy still blocks insert after an accidental grant');
select is(tests.rows_changed($$update public.memberships set role = 'owner' where user_id = 'a4000000-0000-0000-0000-000000000004'$$), 0::bigint, 'restrictive policy still blocks update after an accidental grant');
select is(tests.rows_changed($$delete from public.memberships where user_id = 'a4000000-0000-0000-0000-000000000004'$$), 0::bigint, 'restrictive policy still blocks delete after an accidental grant');
reset role;
revoke insert, update, delete on public.memberships from authenticated;

-- =============================================================================================
-- profiles: own row only
-- =============================================================================================
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select results_eq($$select id from public.profiles$$, $$values ('a1000000-0000-0000-0000-000000000001'::uuid)$$, 'a user reads only their own profile');
select is(tests.rows_changed($$update public.profiles set display_name = 'Alice', avatar_url = 'https://example.com/a.png' where id = 'a1000000-0000-0000-0000-000000000001'$$), 1::bigint, 'and updates their display name and avatar');
select is(tests.rows_changed($$update public.profiles set display_name = 'Pwned' where id = 'a2000000-0000-0000-0000-000000000002'$$), 0::bigint, 'but not someone else''s profile');
select throws_ok($$insert into public.profiles (id, display_name) values (gen_random_uuid(), 'x')$$, '42501', null, 'cannot insert profiles');
select throws_ok($$delete from public.profiles where id = 'a1000000-0000-0000-0000-000000000001'$$, '42501', null, 'cannot delete profiles');
reset role;

-- =============================================================================================
-- the policies are in place and documented by name
-- =============================================================================================
select is(
  (select string_agg(tablename || '.' || policyname || ':' || cmd, ', ' order by tablename, policyname) from pg_policies where schemaname = 'public' and policyname not like 'zz_%'),
  'activity_events.activity_events_select_member:SELECT, customers.customers_insert_creator:INSERT, customers.customers_insert_writer:INSERT, customers.customers_select_member:SELECT, customers.customers_update_writer:UPDATE, demo_workspaces.demo_workspaces_no_delete:DELETE, demo_workspaces.demo_workspaces_no_insert:INSERT, demo_workspaces.demo_workspaces_no_update:UPDATE, demo_workspaces.demo_workspaces_select_owner:SELECT, memberships.memberships_no_delete:DELETE, memberships.memberships_no_insert:INSERT, memberships.memberships_no_update:UPDATE, memberships.memberships_select_same_org:SELECT, opportunities.opportunities_insert_creator:INSERT, opportunities.opportunities_insert_writer:INSERT, opportunities.opportunities_select_member:SELECT, opportunities.opportunities_update_writer:UPDATE, organizations.organizations_no_delete:DELETE, organizations.organizations_no_insert:INSERT, organizations.organizations_select_member:SELECT, organizations.organizations_update_admin:UPDATE, profiles.profiles_select_own:SELECT, profiles.profiles_update_own:UPDATE, tasks.tasks_insert_creator:INSERT, tasks.tasks_insert_writer:INSERT, tasks.tasks_select_member:SELECT, tasks.tasks_update_writer:UPDATE',
  'exactly the documented policies exist');

select * from finish();
rollback;
