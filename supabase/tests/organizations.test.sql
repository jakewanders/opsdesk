-- pgTAP tests for public.organizations and public.memberships (SIT-178): structure, constraints,
-- cascades, and the locked-down default privileges. The last-owner guard has its own file
-- (last-owner-guard.test.sql): it needs a transaction with no owner-less fixtures.
-- RLS policies and grants for real use arrive with SIT-194; until then these tables are closed to
-- every API role.
begin;
select plan(58);

-- ---------------------------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'organizations', 'organizations exists');
select has_table('public', 'memberships', 'memberships exists');
select columns_are(
  'public', 'organizations',
  array['id', 'name', 'slug', 'industry', 'timezone', 'currency', 'kind', 'created_by', 'expires_at', 'created_at', 'updated_at'],
  'organizations has exactly the PRD columns'
);
select columns_are(
  'public', 'memberships',
  array['organization_id', 'user_id', 'role', 'joined_at'],
  'memberships has exactly the PRD columns'
);
select col_is_pk('public', 'organizations', 'id', 'organizations PK is id');
select col_is_pk('public', 'memberships', array['organization_id', 'user_id'], 'memberships PK is (organization_id, user_id)');
select col_type_is('public', 'organizations', 'expires_at', 'timestamp with time zone', 'expires_at is timestamptz');
select col_default_is('public', 'organizations', 'timezone', 'UTC', 'timezone defaults to UTC');
select col_default_is('public', 'organizations', 'currency', 'USD', 'currency defaults to USD');
select has_index('public', 'memberships', 'memberships_user_org_idx', array['user_id', 'organization_id'], 'index (user_id, organization_id)');
select has_index('public', 'memberships', 'memberships_org_role_idx', array['organization_id', 'role'], 'index (organization_id, role)');
select is(
  (select relrowsecurity from pg_class where oid = 'public.organizations'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.memberships'::regclass),
  true, 'row level security is enabled on both tables'
);

-- ---------------------------------------------------------------------------------------------
-- Fixtures: users u1..u3
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, email, is_anonymous) values
  ('11111111-0000-0000-0000-000000000001', 'u1@example.com', false),
  ('22222222-0000-0000-0000-000000000002', 'u2@example.com', false),
  ('33333333-0000-0000-0000-000000000003', null, true);

-- ---------------------------------------------------------------------------------------------
-- organizations: constraints
-- ---------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.organizations (id, name) values ('a0000000-0000-0000-0000-000000000001', 'Acme Co')$$,
  'a minimal real organization is accepted (timezone UTC, currency USD)'
);
select is(
  (select kind || '/' || timezone || '/' || currency from public.organizations where id = 'a0000000-0000-0000-0000-000000000001'),
  'real/UTC/USD', 'defaults: kind real, timezone UTC, currency USD'
);

select throws_ok($$insert into public.organizations (name) values ('A')$$, '23514', null, 'name of 1 character is rejected');
select throws_ok($$insert into public.organizations (name) values ('   ')$$, '23514', null, 'a whitespace-only name is rejected');
select throws_ok($$insert into public.organizations (name) values (repeat('x', 81))$$, '22001', null, 'a name over 80 characters is rejected');
select lives_ok($$insert into public.organizations (name) values ('AB')$$, 'a 2-character name is accepted');
select lives_ok($$insert into public.organizations (name) values (repeat('y', 80))$$, 'an 80-character name is accepted');

select throws_ok($$insert into public.organizations (name, kind) values ('Trial Co', 'trial')$$, '23514', null, 'an unknown kind is rejected');

select throws_ok(
  $$insert into public.organizations (name, kind) values ('Demo no expiry', 'demo')$$,
  '23514', null, 'a demo organization without expires_at is rejected'
);
select throws_ok(
  $$insert into public.organizations (name, kind, expires_at) values ('Real with expiry', 'real', now() + interval '1 day')$$,
  '23514', null, 'a real organization with expires_at is rejected'
);
select lives_ok(
  $$insert into public.organizations (name, kind, expires_at) values ('Demo ok', 'demo', now() + interval '24 hours')$$,
  'a demo organization with expires_at is accepted'
);

select throws_ok($$insert into public.organizations (name, currency) values ('Euro Co', 'EUR')$$, '23514', null, 'a non-USD currency is rejected');

select throws_ok($$insert into public.organizations (name, timezone) values ('Mars Co', 'Mars/Olympus')$$, '23514', null, 'an unknown timezone is rejected');
select throws_ok($$insert into public.organizations (name, timezone) values ('Abbr Co', 'EST')$$, '23514', null, 'a timezone abbreviation is rejected (IANA names only)');
select throws_ok($$insert into public.organizations (name, timezone) values ('Empty Co', '')$$, '23514', null, 'an empty timezone is rejected');
select throws_ok($$insert into public.organizations (name, timezone) values ('Posix Co', 'posix/America/New_York')$$, '23514', null, 'posix/ and right/ aliases are rejected');
select lives_ok($$insert into public.organizations (name, timezone) values ('NY Co', 'America/New_York')$$, 'America/New_York is accepted');
select lives_ok($$insert into public.organizations (name, timezone) values ('London Co', 'Europe/London')$$, 'Europe/London is accepted');

select lives_ok($$insert into public.organizations (name, slug) values ('Slug One', 'slug-one')$$, 'a valid slug is accepted');
select throws_ok($$insert into public.organizations (name, slug) values ('Slug Two', 'slug-one')$$, '23505', null, 'a duplicate slug is rejected');
select throws_ok($$insert into public.organizations (name, slug) values ('Bad Slug', 'Bad Slug!')$$, '23514', null, 'a slug with uppercase, spaces, or punctuation is rejected');
select lives_ok(
  $$insert into public.organizations (name) values ('No slug A'), ('No slug B')$$,
  'many organizations may have a NULL slug'
);

select throws_ok($$insert into public.organizations (name, industry) values ('Ind Co', '')$$, '23514', null, 'an empty industry is rejected (use NULL)');
select throws_ok($$insert into public.organizations (name, industry) values ('Ind Co', repeat('i', 81))$$, '23514', null, 'an industry over 80 characters is rejected');

-- updated_at is maintained by trigger (now() is fixed in a transaction, so overwrite an old value)
update public.organizations set name = 'Acme Co 2', updated_at = timestamptz '2000-01-01'
  where id = 'a0000000-0000-0000-0000-000000000001';
select ok(
  (select updated_at > timestamptz '2001-01-01' from public.organizations where id = 'a0000000-0000-0000-0000-000000000001'),
  'updated_at is maintained by trigger'
);

-- created_by references auth.users; deleting the creator keeps the organization
select throws_ok(
  $$insert into public.organizations (name, created_by) values ('Ghost Co', '99999999-0000-0000-0000-000000000009')$$,
  '23503', null, 'created_by must be an existing auth user'
);
insert into public.organizations (id, name, created_by) values
  ('a0000000-0000-0000-0000-000000000002', 'Made by u2', '22222222-0000-0000-0000-000000000002');
delete from auth.users where id = '22222222-0000-0000-0000-000000000002';
select is(
  (select created_by is null from public.organizations where id = 'a0000000-0000-0000-0000-000000000002'),
  true, 'deleting the creator keeps the organization and nulls created_by'
);

-- ---------------------------------------------------------------------------------------------
-- memberships: constraints
-- ---------------------------------------------------------------------------------------------
insert into public.organizations (id, name) values
  ('b0000000-0000-0000-0000-00000000000a', 'Org A'),
  ('b0000000-0000-0000-0000-00000000000b', 'Org B');
insert into auth.users (id, email) values
  ('44444444-0000-0000-0000-000000000004', 'u4@example.com'),
  ('55555555-0000-0000-0000-000000000005', 'u5@example.com');

select lives_ok(
  $$insert into public.memberships (organization_id, user_id, role) values
    ('b0000000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001', 'owner'),
    ('b0000000-0000-0000-0000-00000000000a', '44444444-0000-0000-0000-000000000004', 'admin'),
    ('b0000000-0000-0000-0000-00000000000a', '55555555-0000-0000-0000-000000000005', 'viewer'),
    ('b0000000-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'owner'),
    ('b0000000-0000-0000-0000-00000000000b', '33333333-0000-0000-0000-000000000003', 'member')$$,
  'memberships with each valid role are accepted'
);
select throws_ok(
  $$insert into public.memberships (organization_id, user_id, role)
    values ('b0000000-0000-0000-0000-00000000000b', '44444444-0000-0000-0000-000000000004', 'superuser')$$,
  '23514', null, 'an unknown role is rejected'
);
select throws_ok(
  $$insert into public.memberships (organization_id, user_id, role)
    values ('b0000000-0000-0000-0000-00000000000a', '44444444-0000-0000-0000-000000000004', 'member')$$,
  '23505', null, 'a second membership for the same (organization, user) is rejected'
);
select throws_ok(
  $$insert into public.memberships (organization_id, user_id, role)
    values ('c0000000-0000-0000-0000-00000000000c', '44444444-0000-0000-0000-000000000004', 'member')$$,
  '23503', null, 'a membership needs an existing organization'
);
select throws_ok(
  $$insert into public.memberships (organization_id, user_id, role)
    values ('b0000000-0000-0000-0000-00000000000b', '99999999-0000-0000-0000-000000000009', 'member')$$,
  '23503', null, 'a membership needs an existing user'
);
select throws_ok(
  $$insert into public.memberships (organization_id, user_id) values ('b0000000-0000-0000-0000-00000000000b', '44444444-0000-0000-0000-000000000004')$$,
  '23502', null, 'role is required'
);

-- ---------------------------------------------------------------------------------------------
-- Cascades
-- ---------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.memberships where organization_id = 'b0000000-0000-0000-0000-00000000000a'), 3,
  'org A has 3 memberships before the delete'
);
delete from public.organizations where id = 'b0000000-0000-0000-0000-00000000000a';
select is(
  (select count(*)::int from public.memberships where organization_id = 'b0000000-0000-0000-0000-00000000000a'), 0,
  'deleting org A deletes its memberships'
);
select is(
  (select count(*)::int from public.memberships where organization_id = 'b0000000-0000-0000-0000-00000000000b'), 2,
  'org B''s memberships are untouched'
);
select is(
  (select count(*)::int from auth.users where id in (
    '11111111-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005')),
  3, 'the users of the deleted organization still exist'
);
select is(
  (select count(*)::int from public.profiles where id in (
    '11111111-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000004', '55555555-0000-0000-0000-000000000005')),
  3, 'their profiles still exist'
);
select is(
  (select count(*)::int from public.organizations where id = 'b0000000-0000-0000-0000-00000000000b'), 1,
  'org B still exists'
);

delete from auth.users where id = '33333333-0000-0000-0000-000000000003';
select is(
  (select count(*)::int from public.memberships where organization_id = 'b0000000-0000-0000-0000-00000000000b'), 1,
  'deleting a user deletes only their memberships (the organization stays)'
);

-- ---------------------------------------------------------------------------------------------
-- Locked down until SIT-194 adds policies and grants
-- ---------------------------------------------------------------------------------------------
select ok(
  not has_table_privilege('anon', 'public.organizations', 'select')
  and not has_table_privilege('authenticated', 'public.organizations', 'select')
  and not has_table_privilege('authenticated', 'public.organizations', 'insert')
  and not has_table_privilege('authenticated', 'public.organizations', 'update')
  and not has_table_privilege('authenticated', 'public.organizations', 'delete'),
  'API roles hold no privileges on organizations'
);
select ok(
  not has_table_privilege('anon', 'public.memberships', 'select')
  and not has_table_privilege('authenticated', 'public.memberships', 'select')
  and not has_table_privilege('authenticated', 'public.memberships', 'insert')
  and not has_table_privilege('authenticated', 'public.memberships', 'update')
  and not has_table_privilege('authenticated', 'public.memberships', 'delete'),
  'API roles hold no privileges on memberships'
);
set local role anon;
select throws_ok($$select * from public.organizations$$, '42501', null, 'anon cannot read organizations');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub": "11111111-0000-0000-0000-000000000001", "role": "authenticated"}';
select throws_ok($$select * from public.memberships$$, '42501', null, 'a signed-in user cannot read memberships yet');
select throws_ok(
  $$insert into public.memberships (organization_id, user_id, role)
    values ('b0000000-0000-0000-0000-00000000000b', '11111111-0000-0000-0000-000000000001', 'owner')$$,
  '42501', null, 'a signed-in user cannot grant themselves a membership'
);
reset role;

-- The timezone check runs as the calling role, so that role needs EXECUTE on the helper. Grant
-- UPDATE temporarily (rolled back) to prove an authenticated update is validated, not refused.
select ok(
  has_function_privilege('authenticated', 'private.is_valid_timezone(text)', 'execute')
  and not has_function_privilege('anon', 'private.is_valid_timezone(text)', 'execute'),
  'authenticated (but not anon) may execute the timezone helper used by the CHECK constraint'
);

select * from finish();
rollback;
