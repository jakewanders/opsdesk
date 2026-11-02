-- pgTAP tests for public.list_workspace_members (SIT-225).
begin;
select plan(13);
select tests.create_fixtures();
update public.profiles set display_name = 'Zed Owner' where id = tests.uid('a_owner');
update public.profiles set display_name = 'Amy Admin' where id = tests.uid('a_admin');
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');
update public.profiles set display_name = '   ' where id = tests.uid('a_viewer');

select is((select prosecdef from pg_proc where oid = 'public.list_workspace_members(uuid)'::regprocedure), true, 'it is SECURITY DEFINER (profiles are private to their owner)');
select is((select proconfig from pg_proc where oid = 'public.list_workspace_members(uuid)'::regprocedure), array['search_path=""'], 'search_path is pinned');
select is(has_function_privilege('anon', 'public.list_workspace_members(uuid)', 'execute'), false, 'anon cannot call it');
select is(has_function_privilege('authenticated', 'public.list_workspace_members(uuid)', 'execute'), true, 'a signed-in user can');
select is(pg_get_function_result('public.list_workspace_members(uuid)'::regprocedure), 'TABLE(user_id uuid, role text, display_name text, joined_at timestamp with time zone)', 'it returns only id, role, display name and join date (no e-mail, no avatar)');

create function pg_temp.members_as(who text, org uuid) returns text language plpgsql as $$
declare out text;
begin
  perform tests.act_as(who);
  select string_agg(display_name || ':' || role, ',' order by display_name, user_id) into out from public.list_workspace_members(org);
  perform tests.reset();
  return out;
end $$;
select is(pg_temp.members_as('a_viewer', tests.org_id('a')), 'Amy Admin:admin,Member:viewer,Sam Member:member,Zed Owner:owner', 'a viewer sees every member of their workspace with name and role; a blank name reads "Member"');
select is(pg_temp.members_as('a_owner', tests.org_id('a')), 'Amy Admin:admin,Member:viewer,Sam Member:member,Zed Owner:owner', 'an owner sees the same');
select is((select count(*) from (select pg_temp.members_as('b_owner', tests.org_id('b'))) s), 1::bigint, 'another workspace has its own list');
select is(pg_temp.members_as('b_owner', tests.org_id('b')) !~ 'Zed|Amy|Sam', true, 'and it contains none of workspace A''s people');
select is(tests.sqlstate_of_as('b_owner', format('select * from public.list_workspace_members(%L)', tests.org_id('a'))), 'OD404', 'a member of another workspace gets OD404 for this one');
select is(tests.sqlstate_of_as('outsider', format('select * from public.list_workspace_members(%L)', tests.org_id('a'))), 'OD404', 'a user with no membership gets OD404');
select is(tests.sqlstate_of_as('a_owner', format('select * from public.list_workspace_members(%L)', gen_random_uuid())), 'OD404', 'an unknown workspace is the same OD404');
select is(tests.denied_as_anon(format('select * from public.list_workspace_members(%L)', tests.org_id('a'))), true, 'a visitor is refused');

select * from finish();
rollback;
