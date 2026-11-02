-- pgTAP tests for the database side of the expired-demo cleanup (SIT-207).
begin;
select plan(54);
select tests.create_fixtures();

-- a probe entity with a clear function, to prove phase 1 runs the registered clearers before deleting
create table public.zz_cleanup_probe (id uuid primary key default gen_random_uuid(), org_id uuid not null, note text);
create function private.zz_clear(org uuid) returns void language plpgsql as $$ begin delete from public.zz_cleanup_probe where org_id = org; insert into public.zz_cleanup_probe (org_id, note) values ('00000000-0000-0000-0000-00000000c1ea', 'cleared ' || org); end $$;
create function private.zz_seed(org uuid) returns void language plpgsql as $$ begin null; end $$;
select private.register_demo_seeder('zz_cleanup', 10, 'private.zz_seed(uuid)'::regprocedure, 1, 'private.zz_clear(uuid)'::regprocedure);

-- fixtures: g1/g2 live demos, g3 an expired demo. Add four more expired demos (guests e1..e4) and data in each
insert into auth.users (id, email, is_anonymous) select ('e000000' || i || '-0000-4000-8000-00000000000' || i)::uuid, null, true from generate_series(1, 4) i;
insert into public.organizations (id, name, kind, expires_at, created_by)
  select ('e00000d' || i || '-0000-4000-8000-00000000000' || i)::uuid, 'Expired ' || i, 'demo', now() + interval '1 hour', ('e000000' || i || '-0000-4000-8000-00000000000' || i)::uuid from generate_series(1, 4) i;
insert into public.memberships (organization_id, user_id, role) select ('e00000d' || i || '-0000-4000-8000-00000000000' || i)::uuid, ('e000000' || i || '-0000-4000-8000-00000000000' || i)::uuid, 'owner' from generate_series(1, 4) i;
select private.register_demo_workspace(('e00000d' || i || '-0000-4000-8000-00000000000' || i)::uuid, ('e000000' || i || '-0000-4000-8000-00000000000' || i)::uuid) from generate_series(1, 4) i;
-- different expiry times so the batch order is deterministic: oldest first
update public.organizations set expires_at = now() - (interval '1 hour' * (5 - substr(name, 9)::int)) where name like 'Expired %';
select private.set_demo_expiry(tests.org_id('expired'), now() - interval '10 minutes');
insert into public.zz_cleanup_probe (org_id, note) select id, 'data' from public.organizations where kind = 'demo';

-- ---- privileges: service_role only
select is((select count(*) from unnest(array['public.cleanup_purge_expired_demos(integer)', 'public.cleanup_next_users(integer, timestamptz)', 'public.cleanup_user_eligible(uuid)', 'public.cleanup_record_user(uuid, text, text)', 'public.cleanup_enqueue_orphans(integer)', 'public.cleanup_queue_size()', 'public.cleanup_purge_expired_keys()']) f where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') or has_function_privilege('public', f, 'execute') or not has_function_privilege('service_role', f, 'execute')), 0::bigint, 'every cleanup function is executable by service_role and by no browser role');
select ok(not has_table_privilege('authenticated', 'private.demo_cleanup_users', 'select') and not has_table_privilege('anon', 'private.demo_cleanup_users', 'select'), 'the retry queue has no client privileges');
select tests.act_as('g1');
select ok(tests.denied($$select public.cleanup_purge_expired_demos(10)$$), 'a guest cannot run the purge');
select tests.reset();
select tests.act_as_anon();
select ok(tests.denied($$select public.cleanup_user_eligible(tests.uid('g1'))$$), 'nor can the anon key');
select tests.reset();

-- ---- the safety predicate (fail closed)
select is(public.cleanup_user_eligible(null), false, 'null is not eligible');
select is(public.cleanup_user_eligible('00000000-0000-0000-0000-000000000000'), false, 'an unknown user is not eligible');
select is(public.cleanup_user_eligible(tests.uid('g1')), false, 'a guest with an ACTIVE demo is not eligible');
select is(public.cleanup_user_eligible(tests.uid('g3')), false, 'a guest whose expired demo still exists is not eligible yet (membership remains)');
select is(public.cleanup_user_eligible(tests.uid('a_owner')), false, 'a registered owner is never eligible');
select is(public.cleanup_user_eligible(tests.uid('outsider')), false, 'nor a registered user with no organization');
insert into auth.users (id, email, is_anonymous) values ('d0000000-0000-4000-8000-0000000000d0', null, true);
select is(public.cleanup_user_eligible('d0000000-0000-4000-8000-0000000000d0'), true, 'an anonymous user with no memberships and no real organization is eligible');
set constraints all immediate;
set constraints all deferred;
alter table public.organizations disable trigger organizations_protect_columns;  -- force the impossible state for the test
update public.organizations set created_by = 'd0000000-0000-4000-8000-0000000000d0' where id = tests.org_id('a');
select is(public.cleanup_user_eligible('d0000000-0000-4000-8000-0000000000d0'), false, 'an anonymous user who created a REAL organization is never eligible');
update public.organizations set created_by = tests.uid('a_owner') where id = tests.org_id('a');
alter table public.organizations enable trigger organizations_protect_columns;
insert into public.memberships (organization_id, user_id, role) values (tests.org_id('a'), 'd0000000-0000-4000-8000-0000000000d0', 'viewer');
select is(public.cleanup_user_eligible('d0000000-0000-4000-8000-0000000000d0'), false, 'nor one who belongs to a real organization');
delete from public.memberships where user_id = 'd0000000-0000-4000-8000-0000000000d0';
delete from auth.users where id = 'd0000000-0000-4000-8000-0000000000d0';

-- ---- phase 1: bounded batches, expired demos only
select throws_ok($$select public.cleanup_purge_expired_demos(0)$$, 'P0001', 'batch_size must be between 1 and 1000', 'a zero batch is refused');
select throws_ok($$select public.cleanup_purge_expired_demos(1001)$$, 'P0001', null, 'and an unreasonable one');
select is((select count(*) from public.organizations where kind = 'demo' and expires_at < now()), 5::bigint, 'five demos are expired (4 + the g3 fixture)');
select is((select (public.cleanup_purge_expired_demos(2)->>'orgs_deleted')::int), 2, 'a batch of 2 deletes exactly 2');
select is((select count(*) from public.organizations where kind = 'demo' and expires_at < now()), 3::bigint, 'leaving three expired');
select ok(not exists (select 1 from public.organizations where name in ('Expired 1', 'Expired 2')), 'the OLDEST expired demos went first');
select is((select count(*) from public.zz_cleanup_probe where note like 'cleared %'), 2::bigint, 'each deleted organization had its registered clear function run');
select is((select count(*) from public.demo_workspaces where organization_id in (select id from public.organizations where name in ('Expired 1', 'Expired 2'))), 0::bigint, 'their mapping rows cascaded');
select is((select count(*) from public.memberships where user_id in ('e0000001-0000-4000-8000-000000000001', 'e0000002-0000-4000-8000-000000000002')), 0::bigint, 'and their memberships');
select is(public.cleanup_queue_size(), 2, 'both owners were queued for phase 2');
select is((select (public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int), 3, 'the next batch takes the rest (3)');
select is((select (public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int), 0, 'and a second run deletes nothing (idempotent)');
select is(public.cleanup_queue_size(), 5, 'five owners queued in total');

-- live demos and real organizations are untouched
select is((select count(*) from public.organizations where kind = 'demo'), 2::bigint, 'only the two live demos remain');
select is((select count(*) from public.organizations where kind = 'real'), 2::bigint, 'both real organizations are untouched');
select is((select count(*) from public.memberships where organization_id in (tests.org_id('a'), tests.org_id('b'))), 8::bigint, 'with all their memberships');
select is((select count(*) from public.zz_cleanup_probe where org_id in (tests.org_id('g1'), tests.org_id('g2')) and note = 'data'), 2::bigint, 'and the live guests'' data');
select is((select count(*) from auth.users where id in (tests.uid('a_owner'), tests.uid('b_owner'), tests.uid('outsider'), tests.uid('g1'), tests.uid('g2'))), 5::bigint, 'phase 1 never deletes a user');

-- ---- the queue and phase 2 bookkeeping
select is((select count(*) from public.cleanup_next_users(10, now() + interval '1 minute')), 5::bigint, 'phase 2 sees all five candidates');
select is((select count(*) from public.cleanup_next_users(2, now() + interval '1 minute')), 2::bigint, 'and the batch size limits what it fetches');
select lives_ok($$select public.cleanup_record_user('e0000001-0000-4000-8000-000000000001', 'failed', 'auth_timeout')$$, 'a failure is recorded');
select is((select attempts || ':' || last_error from private.demo_cleanup_users where user_id = 'e0000001-0000-4000-8000-000000000001'), '1:auth_timeout', 'with its attempt count and error code (never a message or id)');
select is((select count(*) from public.cleanup_next_users(10, now() - interval '1 minute')), 4::bigint, 'a user attempted in this run is not offered again in the same run');
select is((select count(*) from public.cleanup_next_users(10, now() + interval '1 minute')), 5::bigint, 'but is retried by the next one');
select lives_ok($$select public.cleanup_record_user('e0000001-0000-4000-8000-000000000001', 'deleted')$$, 'a deleted user leaves the queue');
select lives_ok($$select public.cleanup_record_user('e0000002-0000-4000-8000-000000000002', 'skipped')$$, 'so does a skipped one');
select throws_ok($$select public.cleanup_record_user('e0000003-0000-4000-8000-000000000003', 'bogus')$$, 'P0001', null, 'an unknown outcome is refused');
select is(public.cleanup_queue_size(), 3, 'three left');

-- ---- orphan guests and expired keys
insert into auth.users (id, email, is_anonymous, created_at) values ('c1000000-0000-4000-8000-0000000000c1', null, true, now() - interval '3 days'), ('c2000000-0000-4000-8000-0000000000c2', null, true, now() - interval '1 hour');
select is(public.cleanup_enqueue_orphans(48), 1, 'an old guest with no organization is queued as an orphan');
select is((select count(*) from private.demo_cleanup_users where user_id = 'c2000000-0000-4000-8000-0000000000c2'), 0::bigint, 'a fresh guest who just signed in is left alone');
select is(public.cleanup_enqueue_orphans(48), 0, 'queueing twice adds nothing');
select is(public.cleanup_purge_expired_keys(), 0, 'with no expired idempotency keys there is nothing to purge');

-- ---- SIT-214: scale, the anonymous-member-of-a-real-org edge, and key retention
-- 220 expired demos at once: every call is bounded by its batch size and repeated calls drain the backlog
insert into auth.users (id, email, is_anonymous) select ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, null, true from generate_series(1, 220) i;
insert into public.organizations (id, name, kind, expires_at, created_by)
  select ('f1000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'Bulk ' || i, 'demo', now() + interval '1 hour', ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 220) i;
insert into public.memberships (organization_id, user_id, role) select ('f1000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'owner' from generate_series(1, 220) i;
select private.register_demo_workspace(('f1000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, ('f0000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid) from generate_series(1, 220) i;
update public.organizations set expires_at = now() - interval '1 minute' where name like 'Bulk %';
-- the same guest also belongs to a real organization (the edge case): the real org and the guest must survive
insert into auth.users (id, email, is_anonymous) values ('f2000000-0000-4000-8000-000000000001', null, true), ('f2000000-0000-4000-8000-000000000002', 'realowner@example.test', false);
insert into public.organizations (id, name, kind, created_by) values ('f3000000-0000-4000-8000-000000000001', 'Real Co', 'real', 'f2000000-0000-4000-8000-000000000002');
insert into public.memberships (organization_id, user_id, role) values ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002', 'owner'), ('f3000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'member');
select is((public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int, 50, 'with 220 expired demos one call deletes exactly the batch size');
select is((select count(*) from public.organizations where name like 'Bulk %'), 170::bigint, 'and leaves the rest for the next call');
select is((public.cleanup_purge_expired_demos(100)->>'orgs_deleted')::int, 100, 'a second call is bounded the same way');
select is((public.cleanup_purge_expired_demos(100)->>'orgs_deleted')::int, 70, 'the last call takes what is left');
select is((public.cleanup_purge_expired_demos(100)->>'orgs_deleted')::int, 0, 'then there is nothing left to do (idempotent)');
select is(public.cleanup_user_eligible('f2000000-0000-4000-8000-000000000001'), false, 'an anonymous user who is a member of a real organization is never eligible for deletion');
select is((select count(*) from public.organizations where id = 'f3000000-0000-4000-8000-000000000001'), 1::bigint, 'and the real organization survived every cleanup call');
-- idempotency keys: past retention removed, current kept (real table, SIT-183)
insert into private.idempotency_keys (user_id, route, key, request_hash, expires_at) values
  ('f2000000-0000-4000-8000-000000000001', 'r', 'key-old-0001', 'hash-hash', now() - interval '2 days'),
  ('f2000000-0000-4000-8000-000000000001', 'r', 'key-old-0002', 'hash-hash', now() - interval '1 second'),
  ('f2000000-0000-4000-8000-000000000001', 'r', 'key-new-0003', 'hash-hash', now() + interval '1 hour');
select is(public.cleanup_purge_expired_keys(), 2, 'keys past their retention are removed');
select is((select count(*) from private.idempotency_keys where user_id = 'f2000000-0000-4000-8000-000000000001'), 1::bigint, 'and a current key is kept');

select * from finish();
rollback;
