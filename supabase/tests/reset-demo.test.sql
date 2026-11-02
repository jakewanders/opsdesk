-- pgTAP tests for reset_demo_workspace() (SIT-205). Uses the shared helpers in 000-test-helpers.test.sql.
begin;
select plan(40);

-- A probe entity: seeder and clearer on a plain table (real entities register the same way)
create table public.zz_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null, n integer not null, label text not null);
create function private.zz_seed(org uuid) returns void language plpgsql as $$
begin
  insert into public.zz_probe (org_id, n, label) select org, i, private.demo_company(i) || ' / ' || private.demo_email(i) from generate_series(1, 6) i;
end $$;
create function private.zz_clear(org uuid) returns void language plpgsql as $$ begin delete from public.zz_probe where org_id = org; end $$;
select private.register_demo_seeder('zz_probe', 500, 'private.zz_seed(uuid)'::regprocedure, 1, 'private.zz_clear(uuid)'::regprocedure);

select tests.create_fixtures();
-- fixtures registered the demos without seeding; seed the two live ones and a real tenant's rows
select private.seed_demo_workspace(tests.org_id('g1'));
select private.seed_demo_workspace(tests.org_id('g2'));
insert into public.zz_probe (org_id, n, label) values (tests.org_id('a'), 1, 'real tenant row'), (tests.org_id('expired'), 1, 'expired demo row');
create temp table baseline as select n, label from public.zz_probe where org_id = tests.org_id('g1');

-- ---- shape and privileges
select is((select pronargs from pg_proc where oid = 'public.reset_demo_workspace(uuid)'::regprocedure), 1::smallint, 'one parameter: the organization id');
select ok((select prosecdef and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'public.reset_demo_workspace(uuid)'::regprocedure), 'SECURITY DEFINER with a pinned empty search_path');
select ok(has_function_privilege('authenticated', 'public.reset_demo_workspace(uuid)', 'execute') and not has_function_privilege('anon', 'public.reset_demo_workspace(uuid)', 'execute') and not has_function_privilege('public', 'public.reset_demo_workspace(uuid)', 'execute'), 'EXECUTE for authenticated only');
select ok(not has_function_privilege('authenticated', 'private.clear_demo_data(uuid)', 'execute') and not has_function_privilege('authenticated', 'private.register_demo_seeder(text, integer, regprocedure, integer, regprocedure)', 'execute'), 'browser roles cannot run the clearing or registry functions');

-- ---- rejections
select tests.act_as_anon();
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, '42501', null, 'the anon key cannot call it');
select tests.reset();
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'OD403', 'Start the demo from the demo page.', 'no identity is rejected');
select tests.reset();
select tests.act_as('a_owner');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('a'))$$, 'OD403', 'Only guest visitors have a demo to reset.', 'a registered user cannot reset (a real organization is never touched)');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'OD403', 'Only guest visitors have a demo to reset.', 'nor a guest''s demo');
select tests.reset();
select tests.act_as_role('authenticated', tests.uid('a_owner'), true);
select throws_ok($$select public.reset_demo_workspace(tests.org_id('a'))$$, 'OD403', null, 'a forged anonymous claim on a registered user is rejected (stored user must be a guest)');
select tests.reset();
select tests.act_as('g2');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'OD404', 'That demo workspace was not found.', 'a guest cannot reset another guest''s demo');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('a'))$$, 'OD404', 'That demo workspace was not found.', 'nor a real organization: the same not-found');
select throws_ok($$select public.reset_demo_workspace('00000000-0000-0000-0000-000000000000')$$, 'OD404', 'That demo workspace was not found.', 'nor an unknown id: indistinguishable from the above');
select throws_ok($$select public.reset_demo_workspace(null)$$, 'OD404', null, 'a null id is just not found');
select tests.reset();
select tests.act_as('g3');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('expired'))$$, 'OD403', 'This demo has expired. Start a new one to keep exploring.', 'a guest cannot reset their own EXPIRED demo');
select tests.reset();
select is((select count(*) from public.zz_probe where org_id = tests.org_id('expired')), 1::bigint, 'and the expired demo''s data is untouched');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1')), 6::bigint, 'no rejected call changed G1''s data');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('a')), 1::bigint, 'nor the real tenant''s');
select is((select last_reset_at from public.demo_workspaces where organization_id = tests.org_id('g1')), null::timestamptz, 'and no rejected call consumed a throttle slot');

-- ---- a successful reset restores the exact seed
-- G1 makes a mess: edit a seeded row, add junk, delete one
update public.zz_probe set label = 'edited by the guest' where org_id = tests.org_id('g1') and n = 1;
insert into public.zz_probe (org_id, n, label) values (tests.org_id('g1'), 99, 'junk 1'), (tests.org_id('g1'), 100, 'junk 2');
delete from public.zz_probe where org_id = tests.org_id('g1') and n = 3;
create temp table before_ids as select id from public.zz_probe where org_id = tests.org_id('g1');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1')), 7::bigint, 'the guest''s workspace is now messy (7 rows, 1 edited)');
create temp table org_before as select name, kind, expires_at, created_by, created_at from public.organizations where id = tests.org_id('g1');
create temp table member_before as select user_id, role from public.memberships where organization_id = tests.org_id('g1');
create temp table users_before as select count(*) as n from auth.users;
select tests.act_as('g1');
create temp table reset_result as select public.reset_demo_workspace(tests.org_id('g1')) as r;
select tests.reset();
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1')), 6::bigint, 'after the reset the counts match a fresh seed (6 rows)');
select is((select count(*) from (select n, label from public.zz_probe where org_id = tests.org_id('g1') except select * from baseline) d), 0::bigint, 'and the content matches the original seed exactly');
select is((select count(*) from (select * from baseline except select n, label from public.zz_probe where org_id = tests.org_id('g1')) d), 0::bigint, 'in both directions (nothing missing, nothing extra)');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1') and n >= 99), 0::bigint, 'the junk is gone');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1') and id in (select id from before_ids)), 0::bigint, 'the rows are new rows, not the old ones restored');
select is((select count(*) from (select name, kind, expires_at, created_by, created_at from public.organizations where id = tests.org_id('g1') except select * from org_before) d), 0::bigint, 'the organization row is unchanged, expires_at included (a reset never extends the 24 hours)');
select is((select count(*) from (select user_id, role from public.memberships where organization_id = tests.org_id('g1') except select * from member_before) d), 0::bigint, 'the owner membership is unchanged');
select is((select n from users_before), (select count(*) from auth.users), 'no user account was created or removed');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g2')), 6::bigint, 'another guest''s data is untouched');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('a')), 1::bigint, 'and so is the real tenant''s');
select is((select (r->>'organization_id') from reset_result), tests.org_id('g1')::text, 'the response names the organization');
select is((select (r->>'seed_version')::int from reset_result), private.demo_seed_version(), 'and the seed version');
select ok((select last_reset_at is not null from public.demo_workspaces where organization_id = tests.org_id('g1')), 'last_reset_at is recorded');
select ok(exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted), 'the reset holds the per-workspace advisory lock');

-- ---- throttle: one reset per minute
select tests.act_as('g1');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'OD429', 'You can reset the demo once a minute. Try again shortly.', 'a second reset within a minute is bounded (429-mapped)');
select tests.reset();
update public.demo_workspaces set last_reset_at = now() - interval '59 seconds' where organization_id = tests.org_id('g1');
select tests.act_as('g1');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'OD429', null, 'still refused at 59 seconds');
select tests.reset();
update public.demo_workspaces set last_reset_at = now() - interval '61 seconds' where organization_id = tests.org_id('g1');
select tests.act_as('g1');
select lives_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'allowed again after a minute');
select tests.reset();

-- ---- atomic: a failure leaves the pre-reset data intact and does not use up the minute
update public.demo_workspaces set last_reset_at = now() - interval '2 minutes' where organization_id = tests.org_id('g1');
update public.zz_probe set label = 'valuable guest work' where org_id = tests.org_id('g1') and n = 2;
create function private.zz_seed_boom(org uuid) returns void language plpgsql as $$ begin raise exception 'seeder failed mid-reset'; end $$;
select private.register_demo_seeder('zz_boom', 20, 'private.zz_seed_boom(uuid)'::regprocedure);
create temp table sv_before as select seed_version, last_reset_at from public.demo_workspaces where organization_id = tests.org_id('g1');
select tests.act_as('g1');
select throws_ok($$select public.reset_demo_workspace(tests.org_id('g1'))$$, 'P0001', 'seeder failed mid-reset', 'a seeder that fails fails the whole reset');
select tests.reset();
select is((select label from public.zz_probe where org_id = tests.org_id('g1') and n = 2), 'valuable guest work', 'and the guest''s data is exactly as it was (the clearing rolled back)');
select is((select count(*) from public.zz_probe where org_id = tests.org_id('g1')), 6::bigint, 'with all its rows');
select is((select count(*) from public.demo_workspaces w join sv_before b on b.seed_version = w.seed_version and b.last_reset_at is not distinct from w.last_reset_at where w.organization_id = tests.org_id('g1')), 1::bigint, 'the seed marker and the throttle are exactly as before (a failed reset does not use up the minute)');
delete from private.demo_seeders where name = 'zz_boom';

select * from finish();
rollback;
