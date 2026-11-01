-- pgTAP tests for the last-owner guard (SIT-178): an organization must always keep an owner.
-- The guard is a DEFERRED constraint trigger, checked at commit. `set constraints all immediate`
-- forces the check inside the test; this file keeps its own transaction free of owner-less fixtures
-- because that statement fires every pending check.
begin;
select plan(12);

insert into auth.users (id, email) values
  ('11111111-0000-0000-0000-000000000001', 'u1@example.com'),
  ('44444444-0000-0000-0000-000000000004', 'u4@example.com'),
  ('55555555-0000-0000-0000-000000000005', 'u5@example.com');

-- An organization with two members: owner u1, admin u4
insert into public.organizations (id, name) values ('d0000000-0000-0000-0000-00000000000d', 'Guard Co');
insert into public.memberships (organization_id, user_id, role) values
  ('d0000000-0000-0000-0000-00000000000d', '11111111-0000-0000-0000-000000000001', 'owner'),
  ('d0000000-0000-0000-0000-00000000000d', '44444444-0000-0000-0000-000000000004', 'admin');

select lives_ok($$set constraints all immediate$$, 'an organization with an owner satisfies the guard');
set constraints all deferred;

select throws_ok(
  $$update public.memberships set role = 'admin'
    where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '11111111-0000-0000-0000-000000000001';
    set constraints all immediate$$,
  'OD409', 'An organization must keep at least one owner.', 'demoting the last owner is rejected'
);
set constraints all deferred;

select throws_ok(
  $$delete from public.memberships
    where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '11111111-0000-0000-0000-000000000001';
    set constraints all immediate$$,
  'OD409', 'An organization must keep at least one owner.', 'removing the last owner is rejected'
);
set constraints all deferred;

select lives_ok(
  $$update public.memberships set role = 'owner'
      where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '44444444-0000-0000-0000-000000000004';
    update public.memberships set role = 'member'
      where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '11111111-0000-0000-0000-000000000001';
    set constraints all immediate$$,
  'handing ownership over inside one transaction is allowed'
);
set constraints all deferred;

select throws_ok(
  $$update public.memberships set role = 'viewer'
    where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '44444444-0000-0000-0000-000000000004';
    set constraints all immediate$$,
  'OD409', null, 'after the hand-over, the new owner is now the last owner and cannot be demoted'
);
set constraints all deferred;

select lives_ok(
  $$insert into public.memberships (organization_id, user_id, role)
      values ('d0000000-0000-0000-0000-00000000000d', '55555555-0000-0000-0000-000000000005', 'owner');
    update public.memberships set role = 'viewer'
      where organization_id = 'd0000000-0000-0000-0000-00000000000d' and user_id = '44444444-0000-0000-0000-000000000004';
    set constraints all immediate$$,
  'with a second owner, one owner may be demoted'
);
set constraints all deferred;

-- Moving a membership to another organization must not strand the old one without an owner
insert into public.organizations (id, name) values ('e0000000-0000-0000-0000-00000000000e', 'Other Co');
insert into public.memberships (organization_id, user_id, role) values
  ('e0000000-0000-0000-0000-00000000000e', '44444444-0000-0000-0000-000000000004', 'owner');
select lives_ok($$set constraints all immediate$$, 'a second organization with its own owner is fine');
set constraints all deferred;
select throws_ok(
  $$update public.memberships set organization_id = 'd0000000-0000-0000-0000-00000000000d'
    where organization_id = 'e0000000-0000-0000-0000-00000000000e' and user_id = '44444444-0000-0000-0000-000000000004';
    set constraints all immediate$$,
  'OD403', null, 'a membership cannot be moved to another organization (immutable organization_id)'
);
set constraints all deferred;

-- A new organization with no owner is rejected at commit
select throws_ok(
  $$insert into public.organizations (name) values ('Ownerless Co'); set constraints all immediate$$,
  'OD409', 'An organization must keep at least one owner.', 'a new organization with no owner is rejected at commit'
);
set constraints all deferred;

-- Deleting a whole organization (cascading its owners) is not blocked
select lives_ok(
  $$delete from public.organizations where id = 'd0000000-0000-0000-0000-00000000000d'; set constraints all immediate$$,
  'deleting a whole organization is not blocked by the guard'
);
set constraints all deferred;

-- Deleting the account of an organization's only owner is blocked while the organization exists
select throws_ok(
  $$delete from auth.users where id = '44444444-0000-0000-0000-000000000004'; set constraints all immediate$$,
  'OD409', 'An organization must keep at least one owner.', 'deleting the only owner''s account while the organization exists is rejected'
);
set constraints all deferred;

-- Function hardening
select ok(
  (select prosecdef and coalesce('search_path=""' = any (proconfig), false)
     from pg_proc where oid = 'private.assert_org_has_owner()'::regprocedure)
  and not has_function_privilege('anon', 'private.assert_org_has_owner()', 'execute')
  and not has_function_privilege('authenticated', 'private.assert_org_has_owner()', 'execute')
  and not has_function_privilege('public', 'private.assert_org_has_owner()', 'execute'),
  'the guard function is SECURITY DEFINER, pins search_path, and is not executable by API roles'
);

select * from finish();
rollback;
