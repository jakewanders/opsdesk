-- pgTAP tests for public.profiles (SIT-167): trigger, column grants, RLS.
-- Run with `npm run test:db` (local database only). Each test file runs in a transaction that
-- is rolled back, so nothing persists.
begin;
select plan(29);

-- ---------------------------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------------------------
select has_table('public', 'profiles', 'profiles table exists');
select col_is_pk('public', 'profiles', 'id', 'id is the primary key');
select columns_are(
  'public', 'profiles',
  array['id', 'display_name', 'avatar_url', 'created_at', 'updated_at'],
  'profiles has exactly the expected columns (no email)'
);
select col_type_is('public', 'profiles', 'created_at', 'timestamp with time zone', 'instants are timestamptz');
select is(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  true,
  'row level security is enabled'
);

-- ---------------------------------------------------------------------------------------------
-- Trigger: exactly one profile per new auth user (real or anonymous), no email copied
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, email, is_anonymous) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'alice.smith@example.com', false),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bob@example.com', false),
  ('cccccccc-0000-0000-0000-000000000003', null, true),
  ('dddddddd-0000-0000-0000-000000000004', null, false);

select is(
  (select count(*)::int from public.profiles where id in (
    'aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002',
    'cccccccc-0000-0000-0000-000000000003', 'dddddddd-0000-0000-0000-000000000004')),
  4,
  'each new user, real or anonymous, gets exactly one profile'
);
select is(
  (select display_name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'alice.smith', 'real user: display name is the email local part'
);
select is(
  (select display_name from public.profiles where id = 'cccccccc-0000-0000-0000-000000000003'),
  'Demo User', 'anonymous user: display name is Demo User'
);
select is(
  (select display_name from public.profiles where id = 'dddddddd-0000-0000-0000-000000000004'),
  'New user', 'real user without an email gets a safe default'
);
select is(
  (select count(*)::int from public.profiles p where p.display_name like '%@%'),
  0, 'no profile display name contains an email address'
);

-- ---------------------------------------------------------------------------------------------
-- Function hardening
-- ---------------------------------------------------------------------------------------------
select ok(
  (select prosecdef from pg_proc where oid = 'private.handle_new_user()'::regprocedure),
  'handle_new_user is SECURITY DEFINER'
);
select ok(
  (select coalesce('search_path=""' = any (proconfig), false)
     from pg_proc where oid = 'private.handle_new_user()'::regprocedure),
  'handle_new_user pins search_path to empty'
);
select ok(
  not has_function_privilege('anon', 'private.handle_new_user()', 'execute')
  and not has_function_privilege('authenticated', 'private.handle_new_user()', 'execute')
  and not has_function_privilege('public', 'private.handle_new_user()', 'execute'),
  'EXECUTE on handle_new_user is revoked from anon, authenticated, and public'
);
select ok(
  not has_schema_privilege('anon', 'private', 'usage')
  and not has_schema_privilege('authenticated', 'private', 'create'),
  'the private schema is not usable by anon, and authenticated (usage only, for RLS helpers) cannot create in it'
);

-- updated_at is maintained by trigger: now() is fixed inside a transaction, so prove it by
-- overwriting a deliberately old value supplied by the statement itself.
update public.profiles
  set display_name = 'Alice', updated_at = timestamptz '2000-01-01'
  where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select ok(
  (select updated_at > timestamptz '2001-01-01' from public.profiles
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'updated_at is maintained by trigger (a client-supplied old value is overwritten)'
);

-- ---------------------------------------------------------------------------------------------
-- RLS: user A (alice)
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub": "aaaaaaaa-0000-0000-0000-000000000001", "role": "authenticated"}';

select is((select count(*)::int from public.profiles), 1, 'A sees exactly one profile');
select is(
  (select id from public.profiles), 'aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'A sees only their own row'
);
select is(
  (select count(*)::int from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  0, 'A cannot select B''s profile'
);

with updated as (
  update public.profiles set display_name = 'Hacked' where id = 'bbbbbbbb-0000-0000-0000-000000000002' returning 1
)
select is((select count(*)::int from updated), 0, 'A cannot update B''s profile (0 rows)');

select lives_ok(
  $$update public.profiles set display_name = 'Alice S', avatar_url = 'https://example.com/a.png'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'A can update their own display_name and avatar_url'
);
select is(
  (select display_name from public.profiles), 'Alice S', 'the update took effect'
);
select throws_ok(
  $$update public.profiles set updated_at = timestamptz '2000-01-01'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '42501', null, 'A cannot write updated_at directly (no column grant)'
);

select throws_ok(
  $$update public.profiles set id = 'eeeeeeee-0000-0000-0000-000000000005'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '42501', null, 'A cannot change the profile id (no column grant)'
);
select throws_ok(
  $$update public.profiles set created_at = now() - interval '1 year'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '42501', null, 'A cannot change created_at (no column grant)'
);
select throws_ok(
  $$update public.profiles set avatar_url = 'javascript:alert(1)'
    where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '23514', null, 'avatar_url must be an https URL'
);
select throws_ok(
  $$insert into public.profiles (id, display_name) values ('eeeeeeee-0000-0000-0000-000000000005', 'x')$$,
  '42501', null, 'authenticated users cannot insert profiles'
);
select throws_ok(
  $$delete from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '42501', null, 'authenticated users cannot delete profiles'
);

-- ---------------------------------------------------------------------------------------------
-- RLS: the anonymous API role (public key, no user) cannot read profiles
-- ---------------------------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select * from public.profiles$$, '42501', null, 'the anon role cannot read profiles'
);

-- ---------------------------------------------------------------------------------------------
-- Cascade: removing the auth user removes the profile
-- ---------------------------------------------------------------------------------------------
reset role;
delete from auth.users where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select is(
  (select count(*)::int from public.profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002'),
  0, 'deleting the auth user deletes the profile'
);

select * from finish();
rollback;
