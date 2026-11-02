-- pgTAP tests for bootstrap_demo_workspace() (SIT-199).
begin;
select plan(53);

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-0000-0000-000000000001', null, true),   -- G1
  ('92000000-0000-0000-0000-000000000002', null, true),   -- G2
  ('93000000-0000-0000-0000-000000000003', null, true),   -- G3 (capacity tests)
  ('a1000000-0000-0000-0000-000000000001', 'member@example.com', false);


-- Probe seeders so the seed contents can be compared between guests
create table public.zz_seed_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null, n integer not null, label text not null);
create function private.zz_seed(org uuid) returns void language plpgsql as $$
begin
  insert into public.zz_seed_probe (org_id, n, label) select org, i, private.demo_company(i) || ' / ' || private.demo_email(i) from generate_series(1, 5) i;
end $$;
select private.register_demo_seeder('zz_probe', 500, 'private.zz_seed(uuid)'::regprocedure);

-- ---- shape and privileges
select is((select pronargs from pg_proc where oid = 'public.bootstrap_demo_workspace()'::regprocedure), 0::smallint, 'the function takes no parameters: nothing identity-like can be passed');
select ok((select prosecdef and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'public.bootstrap_demo_workspace()'::regprocedure), 'SECURITY DEFINER with a pinned empty search_path');
select ok(has_function_privilege('authenticated', 'public.bootstrap_demo_workspace()', 'execute') and not has_function_privilege('anon', 'public.bootstrap_demo_workspace()', 'execute') and not has_function_privilege('public', 'public.bootstrap_demo_workspace()', 'execute'), 'EXECUTE for authenticated only (not anon, not PUBLIC)');

-- ---- rejection
select tests.act_as_role('anon', null, false);
select throws_ok($$select public.bootstrap_demo_workspace()$$, '42501', null, 'the anon key cannot call it');
reset role;
select tests.act_as_role('authenticated', 'a1000000-0000-0000-0000-000000000001', false);
select throws_ok($$select public.bootstrap_demo_workspace()$$, 'OD403', 'The live demo is for guest visitors. Sign out to try it.', 'a registered user is rejected');
reset role;
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', false);
select throws_ok($$select public.bootstrap_demo_workspace()$$, 'OD403', 'The live demo is for guest visitors. Sign out to try it.', 'a JWT claiming is_anonymous = false is rejected even for an anonymous user row');
reset role;
select tests.act_as_role('authenticated', 'a1000000-0000-0000-0000-000000000001', true);
select throws_ok($$select public.bootstrap_demo_workspace()$$, 'OD403', 'The live demo is for guest visitors. Sign out to try it.', 'a forged anonymous claim on a registered user is rejected (the stored user must agree)');
reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok($$select public.bootstrap_demo_workspace()$$, 'OD403', 'Start the demo from the demo page.', 'a call with no identity is rejected');
reset role;
select is((select count(*) from public.organizations where kind = 'demo'), 0::bigint, 'no rejected call created an organization');

-- ---- G1 bootstraps
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
create temp table g1_first as select public.bootstrap_demo_workspace() as r;
reset role;
select is((select (r->>'created')::boolean from g1_first), true, 'the first call creates a workspace');
select is((select count(*) from public.organizations where kind = 'demo' and created_by = '91000000-0000-0000-0000-000000000001'), 1::bigint, 'exactly one demo organization for G1');
select is((select name from public.organizations where id = (select (r->>'organization_id')::uuid from g1_first)), 'Demo Workspace', 'named Demo Workspace');
select ok((select expires_at between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute' from public.organizations where id = (select (r->>'organization_id')::uuid from g1_first)), 'it expires 24 hours from now');
select is((select timezone from public.organizations where id = (select (r->>'organization_id')::uuid from g1_first)), 'UTC', 'with the default time zone');
select is((select string_agg(user_id::text || ':' || role, ',') from public.memberships where organization_id = (select (r->>'organization_id')::uuid from g1_first)), '91000000-0000-0000-0000-000000000001:owner', 'G1 is its only member, as owner');
select is((select display_name from public.profiles where id = '91000000-0000-0000-0000-000000000001'), 'Demo Owner', 'the profile display name is set');
select is((select user_id from public.demo_workspaces where organization_id = (select (r->>'organization_id')::uuid from g1_first)), '91000000-0000-0000-0000-000000000001'::uuid, 'the demo mapping row exists for G1');
select is((select seed_version from public.demo_workspaces where user_id = '91000000-0000-0000-0000-000000000001'), private.demo_seed_version(), 'the seed version is recorded');
select is((select count(*) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g1_first)), 5::bigint, 'the registered seeders ran for the new workspace');
select is((select (r->>'seed_version')::int from g1_first), private.demo_seed_version(), 'and the response reports the seed version');

-- The call holds this user's advisory lock until the transaction ends (that is what serializes racing calls)
select ok(
  exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted),
  'the call takes the per-user advisory lock');

-- ---- repeated calls are idempotent
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
create temp table g1_again as select public.bootstrap_demo_workspace() as r;
create temp table g1_third as select public.bootstrap_demo_workspace() as r;
reset role;
select is((select (r->>'organization_id') from g1_again), (select (r->>'organization_id') from g1_first), 'a repeated call returns the same organization id');
select is((select (r->>'organization_id') from g1_third), (select (r->>'organization_id') from g1_first), 'and so does a third');
select is((select (r->>'created')::boolean from g1_again), false, 'reporting created = false');
select is((select r->>'expires_at' from g1_again), (select r->>'expires_at' from g1_first), 'the expiry is not extended by calling again');
select is((select count(*) from public.organizations where created_by = '91000000-0000-0000-0000-000000000001'), 1::bigint, 'still exactly one organization');
select is((select count(*) from public.memberships where user_id = '91000000-0000-0000-0000-000000000001'), 1::bigint, 'one membership');
select is((select count(*) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g1_first)), 5::bigint, 'and no duplicate seed rows');

-- ---- two guests are isolated and get equal content with separate ids
select tests.act_as_role('authenticated', '92000000-0000-0000-0000-000000000002', true);
create temp table g2_first as select public.bootstrap_demo_workspace() as r;
reset role;
select isnt((select r->>'organization_id' from g2_first), (select r->>'organization_id' from g1_first), 'a different guest gets a different organization');
select is((select count(*) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g2_first)), 5::bigint, 'G2 has their own seed rows');
select is(
  (select md5(string_agg(n || label, '|' order by n)) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g1_first)),
  (select md5(string_agg(n || label, '|' order by n)) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g2_first)),
  'with identical content');
select is((select count(*) from public.zz_seed_probe a join public.zz_seed_probe b on a.id = b.id and a.org_id <> b.org_id), 0::bigint, 'and no shared record ids');
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.organizations), 1::bigint, 'G1 sees only their own organization through RLS');
select is((select id from public.organizations), (select (r->>'organization_id')::uuid from g1_first), 'and it is theirs');
select is((select count(*) from public.memberships), 1::bigint, 'only their own membership');
select is((select count(*) from public.demo_workspaces), 1::bigint, 'and only their own mapping');
select tests.act_as_role('authenticated', '92000000-0000-0000-0000-000000000002', true);
select is((select count(*) from public.organizations where id = (select (r->>'organization_id')::uuid from g1_first)), 0::bigint, 'G2 cannot see G1''s organization');
reset role;

-- ---- a caller cannot choose owner, org id, expiry or kind
select throws_ok($$select public.bootstrap_demo_workspace('d0000000-0000-0000-0000-00000000000d')$$, '42883', null, 'passing an organization id is impossible (no such signature)');
select throws_ok($$select public.bootstrap_demo_workspace(owner_id => '91000000-0000-0000-0000-000000000001')$$, '42883', null, 'passing an owner is impossible');
select tests.act_as_role('authenticated', '92000000-0000-0000-0000-000000000002', true);
select throws_ok($$update public.organizations set expires_at = now() + interval '1 year'$$, '42501', null, 'the guest cannot extend the expiry afterwards');
select throws_ok($$update public.organizations set kind = 'real'$$, '42501', null, 'nor change the kind');
reset role;

-- ---- expired demo: the caller's own is cleaned up and replaced
update public.organizations set expires_at = now() - interval '1 minute' where id = (select (r->>'organization_id')::uuid from g1_first);
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
create temp table g1_fresh as select public.bootstrap_demo_workspace() as r;
reset role;
select is((select (r->>'created')::boolean from g1_fresh), true, 'after expiry a fresh workspace is created');
select isnt((select r->>'organization_id' from g1_fresh), (select r->>'organization_id' from g1_first), 'with a new id');
select is((select count(*) from public.organizations where id = (select (r->>'organization_id')::uuid from g1_first)), 0::bigint, 'and the expired one is gone');
select is((select count(*) from public.zz_seed_probe where org_id = (select (r->>'organization_id')::uuid from g1_first)), 5::bigint, '(probe rows are a plain table without a foreign key, so cleanup of real entities is the cascade of SIT-207)');
select is((select count(*) from public.organizations where created_by = '91000000-0000-0000-0000-000000000001' and kind = 'demo'), 1::bigint, 'G1 again has exactly one demo');
select is((select count(*) from public.organizations where created_by = '92000000-0000-0000-0000-000000000002'), 1::bigint, 'and G2''s workspace was untouched by G1''s cleanup');

-- ---- capacity ceiling
update private.app_limits set value = 2 where key = 'max_active_demos';
select tests.act_as_role('authenticated', '93000000-0000-0000-0000-000000000003', true);
select throws_ok($$select public.bootstrap_demo_workspace()$$, 'OD429', 'The demo is very busy right now. Please try again in a few minutes.', 'at the ceiling a new guest is refused with a 429-mapped error');
reset role;
select is((select count(*) from public.organizations where created_by = '93000000-0000-0000-0000-000000000003'), 0::bigint, 'and nothing was created for them');
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
select is((select (public.bootstrap_demo_workspace()->>'created')::boolean), false, 'but a guest who already has a live demo still gets it at capacity');
reset role;
update private.app_limits set value = 3 where key = 'max_active_demos';
select tests.act_as_role('authenticated', '93000000-0000-0000-0000-000000000003', true);
select is((select (public.bootstrap_demo_workspace()->>'created')::boolean), true, 'raising the ceiling lets them in');
reset role;
select ok(not has_table_privilege('authenticated', 'private.app_limits', 'select') and not has_table_privilege('anon', 'private.app_limits', 'select'), 'the limits table has no client privileges');
select ok(not has_function_privilege('authenticated', 'private.demo_limit(text)', 'execute'), 'and the limit reader is not callable by clients');

select * from finish();
rollback;
