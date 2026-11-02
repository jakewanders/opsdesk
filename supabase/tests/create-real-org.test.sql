-- pgTAP tests for create_real_organization() (SIT-198). Uses the shared helpers in 000-test-helpers.test.sql.
begin;
select plan(56);
select tests.create_fixtures();

-- ---- shape and privileges
select is((select pronargs from pg_proc where oid = 'public.create_real_organization(text, text, text)'::regprocedure), 3::smallint, 'exactly three parameters');
select is((select array_agg(a order by ord) from pg_proc p, unnest(p.proargnames) with ordinality as t(a, ord) where p.oid = 'public.create_real_organization(text, text, text)'::regprocedure), array['org_name', 'org_industry', 'org_timezone'], 'they are name, industry and time zone: no owner, organization or user id');
select ok((select prosecdef and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'public.create_real_organization(text, text, text)'::regprocedure), 'SECURITY DEFINER with a pinned empty search_path');
select ok(has_function_privilege('authenticated', 'public.create_real_organization(text, text, text)', 'execute') and not has_function_privilege('anon', 'public.create_real_organization(text, text, text)', 'execute') and not has_function_privilege('public', 'public.create_real_organization(text, text, text)', 'execute'), 'EXECUTE for authenticated only');
select is((select value from private.app_limits where key = 'max_real_orgs_per_user'), 5, 'the per-user limit is 5 by default');
select ok(not has_function_privilege('authenticated', 'private.app_limit(text)', 'execute'), 'and clients cannot read the limit helper');

-- ---- rejection
select tests.act_as_anon();
select throws_ok($$select public.create_real_organization('Acme Plumbing')$$, '42501', null, 'the anon key cannot call it');
select tests.reset();
select tests.act_as('g1');
select throws_ok($$select public.create_real_organization('Acme Plumbing')$$, 'OD403', 'Create an account to keep your data. Guests cannot create workspaces.', 'an anonymous guest is rejected');
select tests.reset();
select tests.act_as_role('authenticated', tests.uid('g1'), false);
select throws_ok($$select public.create_real_organization('Acme Plumbing')$$, 'OD403', null, 'a guest whose JWT claims is_anonymous = false is still rejected (stored user must be registered)');
select tests.reset();
select tests.act_as_role('authenticated', tests.uid('outsider'), true);
select throws_ok($$select public.create_real_organization('Acme Plumbing')$$, 'OD403', null, 'a registered user with a forged anonymous claim is rejected');
select tests.reset();
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok($$select public.create_real_organization('Acme Plumbing')$$, 'OD403', 'Sign in to create a workspace.', 'a call with no identity is rejected');
select tests.reset();
select is((select count(*) from public.organizations), 5::bigint, 'no rejected call created anything (only the five fixture organizations)');

-- ---- success
select tests.act_as('outsider');
create temp table made as select public.create_real_organization('  Acme Plumbing  ', 'Plumbing', 'America/New_York') as id;
select tests.reset();
select is((select count(*) from public.organizations where created_by = tests.uid('outsider')), 1::bigint, 'exactly one organization was created');
select is((select name from public.organizations where id = (select id from made)), 'Acme Plumbing', 'the name is trimmed');
select is((select kind from public.organizations where id = (select id from made)), 'real', 'kind is real');
select is((select expires_at from public.organizations where id = (select id from made)), null::timestamptz, 'with no expiry');
select is((select industry from public.organizations where id = (select id from made)), 'Plumbing', 'industry stored');
select is((select timezone from public.organizations where id = (select id from made)), 'America/New_York', 'time zone stored');
select is((select currency from public.organizations where id = (select id from made))::text, 'USD', 'currency is USD');
select is((select created_by from public.organizations where id = (select id from made)), tests.uid('outsider'), 'created_by is the caller');
select is((select string_agg(user_id::text || ':' || role, ',') from public.memberships where organization_id = (select id from made)), tests.uid('outsider')::text || ':owner', 'and the caller is its only member, as owner');
select tests.act_as('outsider');
select is((select count(*) from public.organizations), 1::bigint, 'the creator sees their organization through RLS');
select is((select count(*) from public.memberships), 1::bigint, 'and their membership');
select tests.reset();
select tests.act_as('a_owner');
select is((select count(*) from public.organizations where id = (select id from made)), 0::bigint, 'other tenants cannot see it');
select tests.reset();

-- defaults
select tests.act_as('b_owner');
create temp table made2 as select public.create_real_organization('Defaults Co') as id;
select tests.reset();
select is((select timezone from public.organizations where id = (select id from made2)), 'UTC', 'the time zone defaults to UTC');
select is((select industry from public.organizations where id = (select id from made2)), null::text, 'and industry to null');

-- ---- validation (backstop for the API's Zod rules)
select tests.act_as('a_member');
select throws_ok($$select public.create_real_organization('A')$$, 'OD422', 'Workspace name must be 2 to 80 characters of plain text.', 'a 1-character name is refused');
select throws_ok($$select public.create_real_organization('   ')$$, 'OD422', null, 'a blank name is refused');
select throws_ok($$select public.create_real_organization(null)$$, 'OD422', null, 'a null name is refused');
select throws_ok(format('select public.create_real_organization(%L)', repeat('x', 81)), 'OD422', null, 'an 81-character name is refused');
select lives_ok(format('select public.create_real_organization(%L)', repeat('x', 80)), 'an 80-character name is accepted');
select lives_ok(format('select public.create_real_organization(%L)', repeat('😀', 80)), 'length counts code points: 80 emoji are accepted');
select throws_ok(format('select public.create_real_organization(%L)', repeat('😀', 81)), 'OD422', null, 'and 81 are not');
select throws_ok($$select public.create_real_organization('<script>alert(1)</script>')$$, 'OD422', null, 'markup in the name is refused');
select throws_ok($$select public.create_real_organization('Bad' || chr(7) || 'Name')$$, 'OD422', null, 'control characters are refused');
select lives_ok($$select public.create_real_organization('Revenue < Costs Ltd')$$, 'a bare < in prose is fine');
select throws_ok($$select public.create_real_organization('Acme', repeat('y', 81))$$, 'OD422', 'Industry must be 80 characters or fewer of plain text.', 'an over-long industry is refused');
select throws_ok($$select public.create_real_organization('Acme', '<b>x</b>')$$, 'OD422', null, 'markup in industry is refused');
select throws_ok($$select public.create_real_organization('Acme', null, 'Mars/Base')$$, 'OD422', 'Choose a valid time zone.', 'an unknown time zone is refused');
select throws_ok($$select public.create_real_organization('Acme', null, 'EST')$$, 'OD422', null, 'an abbreviation is refused');
select throws_ok($$select public.create_real_organization('Acme', null, 'posix/UTC')$$, 'OD422', null, 'a posix alias is refused');
select tests.reset();
select is((select count(*) from public.organizations where created_by = tests.uid('a_member')), 3::bigint, 'only the 3 accepted calls created organizations');
select ok((select bool_and(kind = 'real' and expires_at is null and exists (select 1 from public.memberships m where m.organization_id = o.id and m.user_id = o.created_by and m.role = 'owner')) from public.organizations o where created_by = tests.uid('a_member')), 'each accepted organization has its owner membership');

-- ---- per-user limit
select tests.act_as('b_viewer');
select lives_ok($$select public.create_real_organization('Limit 1')$$, 'creation 1 of the limit');
select lives_ok($$select public.create_real_organization('Limit 2')$$, 'creation 2');
select lives_ok($$select public.create_real_organization('Limit 3')$$, 'creation 3');
select lives_ok($$select public.create_real_organization('Limit 4')$$, 'creation 4');
select lives_ok($$select public.create_real_organization('Limit 5')$$, 'creation 5');
select throws_ok($$select public.create_real_organization('Limit 6')$$, 'OD429', 'You have reached the limit of workspaces for one account.', 'the sixth is refused with a 429-mapped error');
select tests.reset();
select is((select count(*) from public.organizations where created_by = tests.uid('b_viewer')), 5::bigint, 'and only five exist');
select tests.act_as('b_admin');
select lives_ok($$select public.create_real_organization('Another user is fine')$$, 'the limit is per user, not global');
select tests.reset();
update private.app_limits set value = 6 where key = 'max_real_orgs_per_user';
select tests.act_as('b_viewer');
select lives_ok($$select public.create_real_organization('Limit 6 after raise')$$, 'raising the limit admits another');
select tests.reset();

-- ---- atomicity: a failure mid-function leaves no partial rows
create function public.zz_boom() returns trigger language plpgsql as $$ begin raise exception 'forced failure after the organization insert'; end $$;
create trigger zz_boom before insert on public.memberships for each row execute function public.zz_boom();
select tests.act_as('b_member');
select throws_ok($$select public.create_real_organization('Atomic Co')$$, 'P0001', 'forced failure after the organization insert', 'a failure while adding the owner membership fails the call');
select tests.reset();
select is((select count(*) from public.organizations where name = 'Atomic Co'), 0::bigint, 'and the organization insert was rolled back with it');
drop trigger zz_boom on public.memberships;

-- ---- concurrency: the per-user advisory lock is taken
select tests.act_as('b_member');
select lives_ok($$select public.create_real_organization('Lock Co')$$, 'a creation works after the failure');
select tests.reset();
select ok(exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted), 'the call holds the per-user advisory lock for its transaction');

select * from finish();
rollback;
