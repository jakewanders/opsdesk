-- pgTAP tests for the RLS helper functions (SIT-187).
begin;
select plan(31);

insert into auth.users (id, email, is_anonymous) values
  ('a1000000-0000-0000-0000-000000000001', 'owner@example.com', false),
  ('a2000000-0000-0000-0000-000000000002', 'admin@example.com', false),
  ('a3000000-0000-0000-0000-000000000003', 'member@example.com', false),
  ('a4000000-0000-0000-0000-000000000004', 'viewer@example.com', false),
  ('a5000000-0000-0000-0000-000000000005', 'outsider@example.com', false),
  ('a6000000-0000-0000-0000-000000000006', null, true);

insert into public.organizations (id, name) values ('b1000000-0000-0000-0000-00000000000b', 'Real Co');
insert into public.organizations (id, name, kind, expires_at)
  values ('b2000000-0000-0000-0000-00000000000b', 'Live Demo', 'demo', now() + interval '1 hour'),
         ('b3000000-0000-0000-0000-00000000000b', 'Dead Demo', 'demo', now() + interval '1 hour');
insert into public.memberships (organization_id, user_id, role) values
  ('b1000000-0000-0000-0000-00000000000b', 'a1000000-0000-0000-0000-000000000001', 'owner'),
  ('b1000000-0000-0000-0000-00000000000b', 'a2000000-0000-0000-0000-000000000002', 'admin'),
  ('b1000000-0000-0000-0000-00000000000b', 'a3000000-0000-0000-0000-000000000003', 'member'),
  ('b1000000-0000-0000-0000-00000000000b', 'a4000000-0000-0000-0000-000000000004', 'viewer'),
  ('b2000000-0000-0000-0000-00000000000b', 'a6000000-0000-0000-0000-000000000006', 'owner'),
  ('b3000000-0000-0000-0000-00000000000b', 'a6000000-0000-0000-0000-000000000006', 'owner');
-- Expire the second demo (cannot insert it already expired? it can: the check only requires non-null)
update public.organizations set expires_at = now() - interval '1 minute' where id = 'b3000000-0000-0000-0000-00000000000b';


-- ---- identity helpers
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select is(private.current_user_id(), 'a1000000-0000-0000-0000-000000000001'::uuid, 'current_user_id returns the JWT subject');
select is(private.is_anonymous(), false, 'a registered user is not anonymous');
select tests.act_as_uid('a6000000-0000-0000-0000-000000000006', true);
select is(private.is_anonymous(), true, 'an anonymous sign-in is anonymous');
reset role;
select set_config('request.jwt.claims', '', true);
select is(private.current_user_id(), null, 'without a JWT there is no current user');
select is(private.is_anonymous(), false, 'without a JWT the caller is not anonymous');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-0000-0000-000000000001","is_anonymous":"yes"}', true);
select is(private.is_anonymous(), false, 'a malformed is_anonymous claim counts as not anonymous');

-- ---- membership and role per actor
select tests.act_as_uid('a1000000-0000-0000-0000-000000000001');
select is(private.is_member('b1000000-0000-0000-0000-00000000000b'), true, 'owner is a member');
select is(private.has_role('b1000000-0000-0000-0000-00000000000b', array['owner']), true, 'owner has role owner');
select is(private.has_role('b1000000-0000-0000-0000-00000000000b', array['viewer']), false, 'owner does not have role viewer');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), true, 'owner can write a real org');

select tests.act_as_uid('a2000000-0000-0000-0000-000000000002');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), true, 'admin can write');
select tests.act_as_uid('a3000000-0000-0000-0000-000000000003');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), true, 'member can write');
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select is(private.is_member('b1000000-0000-0000-0000-00000000000b'), true, 'viewer is a member');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), false, 'viewer cannot write');

select tests.act_as_uid('a5000000-0000-0000-0000-000000000005');
select is(private.is_member('b1000000-0000-0000-0000-00000000000b'), false, 'a non-member is not a member');
select is(private.has_role('b1000000-0000-0000-0000-00000000000b', array['owner','admin','member','viewer']), false, 'a non-member has no role');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), false, 'a non-member cannot write');
select is(private.is_member('b2000000-0000-0000-0000-00000000000b'), false, 'a member of one org is not a member of another');

-- ---- anonymous guest and demo expiry
select tests.act_as_uid('a6000000-0000-0000-0000-000000000006', true);
select is(private.can_write('b2000000-0000-0000-0000-00000000000b'), true, 'the guest can write their live demo');
select is(private.org_is_writable('b2000000-0000-0000-0000-00000000000b'), true, 'a live demo is writable');
select is(private.is_member('b3000000-0000-0000-0000-00000000000b'), true, 'the guest is still a member of an expired demo');
select is(private.org_is_writable('b3000000-0000-0000-0000-00000000000b'), false, 'an expired demo is not writable');
select is(private.can_write('b3000000-0000-0000-0000-00000000000b'), false, 'the guest cannot write an expired demo');
select is(private.can_write('b1000000-0000-0000-0000-00000000000b'), false, 'the guest cannot write a real org they do not belong to');
select is(private.org_is_writable('00000000-0000-0000-0000-000000000000'), false, 'an unknown org is not writable');

-- ---- recursion: a policy on memberships may call a helper that reads memberships
reset role;
create policy zz_recursion_probe on public.memberships for select to authenticated
  using (private.is_member(organization_id));
grant select on public.memberships to authenticated;
select tests.act_as_uid('a4000000-0000-0000-0000-000000000004');
select lives_ok($$select count(*) from public.memberships$$, 'a memberships policy using a helper does not recurse');
select is((select count(*) from public.memberships), 4::bigint, 'the probe policy shows only the caller''s own organization memberships');
reset role;

-- ---- privileges
select ok(
  not has_function_privilege('anon', 'private.is_member(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.has_role(uuid, text[])', 'execute')
  and not has_function_privilege('anon', 'private.can_write(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.org_is_writable(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.current_user_id()', 'execute')
  and not has_function_privilege('anon', 'private.is_anonymous()', 'execute'),
  'anon cannot execute any helper');
select ok(
  has_function_privilege('authenticated', 'private.can_write(uuid)', 'execute')
  and has_function_privilege('service_role', 'private.can_write(uuid)', 'execute'),
  'authenticated and service_role can execute the helpers');
select ok(not has_function_privilege('public', 'private.can_write(uuid)', 'execute'), 'PUBLIC cannot execute the helpers');

-- ---- catalog guard: every SECURITY DEFINER function in our schemas pins an empty search_path
select is(
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not coalesce('search_path=""' = any (p.proconfig), false)),
  '', 'no SECURITY DEFINER function in public or private lacks search_path = ''''');

select * from finish();
rollback;
