-- pgTAP tests for the immutability triggers (SIT-188).
begin;
select plan(40);

insert into auth.users (id, email) values
  ('c1000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('c2000000-0000-0000-0000-000000000002', 'creator@example.com');
insert into public.organizations (id, name, created_by) values
  ('d1000000-0000-0000-0000-00000000000d', 'Real Co', 'c2000000-0000-0000-0000-000000000002');
insert into public.organizations (id, name, kind, expires_at, created_by)
  values ('d2000000-0000-0000-0000-00000000000d', 'Demo Co', 'demo', now() + interval '1 hour', 'c1000000-0000-0000-0000-000000000001');
insert into public.memberships (organization_id, user_id, role) values
  ('d1000000-0000-0000-0000-00000000000d', 'c1000000-0000-0000-0000-000000000001', 'owner'),
  ('d1000000-0000-0000-0000-00000000000d', 'c2000000-0000-0000-0000-000000000002', 'admin'),
  ('d2000000-0000-0000-0000-00000000000d', 'c1000000-0000-0000-0000-000000000001', 'owner');

-- The triggers are what is under test, so row level security is switched off for the three tables for this
-- transaction (rolled back); the API roles' column grants still apply. Grants for service_role are temporary too.
grant select, update on public.organizations, public.memberships, public.profiles to authenticated, service_role;
set constraints all immediate;
set constraints all deferred;
alter table public.organizations disable row level security;
alter table public.memberships disable row level security;
alter table public.profiles disable row level security;

create or replace function pg_temp.act_as(r text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1000000-0000-0000-0000-000000000001', 'role', r)::text, true);
  execute format('set local role %I', r);
end $$;
grant execute on function pg_temp.act_as(text) to public;

-- ---- privileges
select ok(
  not has_function_privilege('authenticated', 'private.prevent_column_change()', 'execute')
  and not has_function_privilege('anon', 'private.protect_columns(regclass, text[])', 'execute')
  and not has_function_privilege('authenticated', 'private.protect_org_expiry()', 'execute')
  and not has_function_privilege('authenticated', 'private.set_demo_expiry(uuid, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'private.set_demo_expiry(uuid, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'private.set_demo_expiry(uuid, timestamptz)', 'execute'),
  'helpers are closed to API roles; only service_role may run set_demo_expiry'
);

-- ---- a normal authenticated session: every protected column on organizations
select pg_temp.act_as('authenticated');
select throws_ok($$update public.organizations set id = gen_random_uuid() where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'organizations.id is immutable');
select throws_ok($$update public.organizations set created_at = now() - interval '1 year' where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'organizations.created_at is immutable');
select throws_ok($$update public.organizations set created_by = 'c1000000-0000-0000-0000-000000000001' where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'organizations.created_by cannot be reassigned');
select throws_ok($$update public.organizations set created_by = null where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'organizations.created_by cannot be cleared by a client');
select throws_ok($$update public.organizations set kind = 'demo', expires_at = now() + interval '1 day' where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'a real organization cannot become a demo');
select throws_ok($$update public.organizations set kind = 'real', expires_at = null where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'a demo cannot become real (escaping expiry)');
select throws_ok($$update public.organizations set expires_at = now() + interval '10 years' where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'a demo owner cannot extend their own expiry');
select throws_ok($$update public.organizations set expires_at = now() - interval '1 day' where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'nor change it at all');
select lives_ok($$update public.organizations set name = 'Renamed Co' where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'ordinary columns still update');
select is((select name from public.organizations where id = 'd1000000-0000-0000-0000-00000000000d'), 'Renamed Co', 'and the change was saved');

-- ---- updated_at is the server's, never the client's
update public.organizations set name = 'Again Co', updated_at = '2001-01-01' where id = 'd1000000-0000-0000-0000-00000000000d';
select ok((select updated_at > now() - interval '1 minute' from public.organizations where id = 'd1000000-0000-0000-0000-00000000000d'), 'a client-supplied updated_at is overwritten with server time');
update public.organizations set updated_at = '2001-01-01' where id = 'd1000000-0000-0000-0000-00000000000d';
select ok((select updated_at > now() - interval '1 minute' from public.organizations where id = 'd1000000-0000-0000-0000-00000000000d'), 'setting only updated_at still yields server time');

-- ---- memberships
select throws_ok($$update public.memberships set organization_id = 'd2000000-0000-0000-0000-00000000000d' where organization_id = 'd1000000-0000-0000-0000-00000000000d' and user_id = 'c2000000-0000-0000-0000-000000000002'$$, 'OD403', 'This field cannot be changed.', 'memberships.organization_id is immutable');
select throws_ok($$update public.memberships set user_id = 'c1000000-0000-0000-0000-000000000001' where organization_id = 'd1000000-0000-0000-0000-00000000000d' and user_id = 'c2000000-0000-0000-0000-000000000002'$$, 'OD403', 'This field cannot be changed.', 'memberships.user_id is immutable');
select throws_ok($$update public.memberships set joined_at = now() - interval '1 year' where organization_id = 'd1000000-0000-0000-0000-00000000000d' and user_id = 'c2000000-0000-0000-0000-000000000002'$$, 'OD403', 'This field cannot be changed.', 'memberships.joined_at is immutable');
select lives_ok($$update public.memberships set role = 'member' where organization_id = 'd1000000-0000-0000-0000-00000000000d' and user_id = 'c2000000-0000-0000-0000-000000000002'$$, 'the role itself is not protected by this trigger (the RPC and policies guard it)');

-- ---- profiles
select throws_ok($$update public.profiles set id = 'c2000000-0000-0000-0000-000000000002' where id = 'c1000000-0000-0000-0000-000000000001'$$, 'OD403', 'This field cannot be changed.', 'profiles.id is immutable');
select throws_ok($$update public.profiles set created_at = now() - interval '1 year' where id = 'c1000000-0000-0000-0000-000000000001'$$, 'OD403', 'This field cannot be changed.', 'profiles.created_at is immutable');
select lives_ok($$update public.profiles set display_name = 'New Name' where id = 'c1000000-0000-0000-0000-000000000001'$$, 'profiles.display_name still updates');

-- ---- the error maps to a 403 with a machine code
reset role;
select is(
  (select count(*) from pg_catalog.pg_trigger where tgrelid in ('public.organizations'::regclass, 'public.memberships'::regclass, 'public.profiles'::regclass) and tgname like '%protect%' and tgenabled = 'O'),
  4::bigint, 'four protection triggers are installed and enabled (organizations x2, memberships, profiles)'
);

-- ---- trusted paths
select pg_temp.act_as('service_role');
select lives_ok($$update public.organizations set expires_at = now() + interval '2 days' where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'service_role may change expires_at');
select throws_ok($$update public.organizations set kind = 'real', expires_at = null where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'but not even service_role may change kind');
select throws_ok($$update public.organizations set created_by = null where id = 'd1000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'nor created_by');
select lives_ok($$select private.set_demo_expiry('d2000000-0000-0000-0000-00000000000d', now() + interval '24 hours')$$, 'service_role can call set_demo_expiry');
select ok((select expires_at between now() + interval '23 hours' and now() + interval '25 hours' from public.organizations where id = 'd2000000-0000-0000-0000-00000000000d'), 'and it resets the expiry');
select throws_ok($$select private.set_demo_expiry('d1000000-0000-0000-0000-00000000000d', now() + interval '1 day')$$, 'OD404', 'That demo workspace was not found.', 'set_demo_expiry never touches a real organization');
select throws_ok($$select private.set_demo_expiry('00000000-0000-0000-0000-000000000000', now() + interval '1 day')$$, 'OD404', 'That demo workspace was not found.', 'or an unknown id');
select throws_ok($$select private.set_demo_expiry('d2000000-0000-0000-0000-00000000000d', null)$$, 'OD422', 'A demo workspace needs an expiry time.', 'and refuses a null expiry');
reset role;
select pg_temp.act_as('authenticated');
select throws_ok($$select private.set_demo_expiry('d2000000-0000-0000-0000-00000000000d', now() + interval '1 year')$$, '42501', null, 'an API user cannot call set_demo_expiry directly');
reset role;

-- ---- definer code (the owner) may change expiry: this is how bootstrap/reset RPCs will do it
select lives_ok($$update public.organizations set expires_at = now() + interval '3 hours' where id = 'd2000000-0000-0000-0000-00000000000d'$$, 'the owner role (definer functions) may change expires_at');

-- ---- ON DELETE SET NULL is a referential action, not a client change
select lives_ok($$delete from auth.users where id = 'c2000000-0000-0000-0000-000000000002'$$, 'deleting a creator account is not blocked by the created_by protection');
select is((select created_by from public.organizations where id = 'd1000000-0000-0000-0000-00000000000d'), null::uuid, 'and the reference was cleared by the foreign key');

-- ---- the helper attaches in one line and fails loudly on a typo
create table public.zz_widgets (id uuid primary key default gen_random_uuid(), organization_id uuid not null, created_by uuid, note text);
insert into public.zz_widgets (id, organization_id, note) values ('f0000000-0000-0000-0000-00000000000f', 'd1000000-0000-0000-0000-00000000000d', 'x');
select lives_ok($$select private.protect_columns('public.zz_widgets', 'organization_id', 'created_by')$$, 'one line attaches the protection to a new table');
select throws_ok($$update public.zz_widgets set organization_id = 'd2000000-0000-0000-0000-00000000000d'$$, 'OD403', 'This field cannot be changed.', 'the new table protects organization_id');
select lives_ok($$update public.zz_widgets set note = 'y'$$, 'and still updates other columns');
select lives_ok($$update public.zz_widgets set organization_id = organization_id$$, 'writing the same value is not a change');
select throws_ok($$select private.protect_columns('public.zz_widgets', 'no_such_column')$$, 'P0001', 'Cannot protect "no_such_column": no such column on public.zz_widgets', 'attaching to a missing column fails');
select lives_ok($$select private.protect_columns('public.zz_widgets', 'organization_id', 'created_by')$$, 'attaching twice is safe (create or replace)');
create trigger zz_bad before update on public.zz_widgets for each row execute function private.prevent_column_change('typo_column');
select throws_ok($$update public.zz_widgets set note = 'z'$$, 'P0001', 'Protected column "typo_column" does not exist on public.zz_widgets', 'a typo in a hand-written trigger fails loudly instead of protecting nothing');

select * from finish();
rollback;
