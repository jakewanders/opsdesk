-- pgTAP tests for public.import_jobs (SIT-223, PRD 6.2, US-10): shape, who can read and write, the count and status rules,
-- the error-summary cap, immutability of finished jobs, the repeat-protection index, the demo cap, and expiry cleanup.
-- The "writer" in most tests is the trusted role (as the import functions will be); clients are tested separately and cannot write.
begin;
select plan(61);
select tests.create_fixtures();

create function pg_temp.job(jid uuid, org uuid, creator uuid, sha text default repeat('a', 64)) returns void language plpgsql as $$
begin
  insert into public.import_jobs (id, organization_id, created_by, file_sha256, total_rows) values (jid, org, creator, sha, 10);
end $$;

-- ---- shape
select has_table('public', 'import_jobs', 'import_jobs exists');
select is((select relrowsecurity from pg_class where oid = 'public.import_jobs'::regclass), true, 'row level security is on');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'import_jobs' and grantee = 'authenticated'), 'SELECT', 'authenticated can only SELECT');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'import_jobs' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds no privilege');
select is((select string_agg(policyname || ':' || cmd, ',') from pg_policies where schemaname = 'public' and tablename = 'import_jobs'), 'import_jobs_select_member:SELECT', 'the only policy is member select');
select is((select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a where a.attrelid = 'public.import_jobs'::regclass and a.attnum > 0 and not a.attisdropped),
  'id,organization_id,created_by,file_sha256,status,total_rows,imported_rows,rejected_rows,error_summary,created_at,expires_at,completed_at', 'the columns are the PRD columns plus expires_at');
select is((select indexdef from pg_indexes where schemaname = 'public' and indexname = 'import_jobs_org_file_created_idx'),
  'CREATE INDEX import_jobs_org_file_created_idx ON public.import_jobs USING btree (organization_id, file_sha256, created_at DESC)', 'the repeat-protection index is (organization_id, file_sha256, created_at desc)');
select is((select count(*) from pg_trigger where tgrelid = 'public.import_jobs'::regclass and tgname = 'import_jobs_demo_cap'), 1::bigint, 'the demo cap trigger is attached');

-- ---- a job, written by the trusted role
select lives_ok($$select pg_temp.job('f1000000-0000-4000-8000-000000000001', tests.org_id('a'), tests.uid('a_member'))$$, 'a preview job is created');
select is((select status || '|' || imported_rows || '|' || rejected_rows || '|' || error_summary::text || '|' || (completed_at is null) from public.import_jobs where id = 'f1000000-0000-4000-8000-000000000001'),
  'previewed|0|0|[]|true', 'it starts previewed with nothing imported, an empty summary and no completion time');
select is((select expires_at - created_at from public.import_jobs where id = 'f1000000-0000-4000-8000-000000000001'), interval '1 hour', 'a preview expires one hour after it was created');
select lives_ok($$select pg_temp.job('f1000000-0000-4000-8000-000000000002', tests.org_id('b'), tests.uid('b_member'), repeat('b', 64))$$, 'a job in the other organization');
select lives_ok($$select pg_temp.job('f1000000-0000-4000-8000-000000000003', tests.org_id('g1'), tests.uid('g1'), repeat('c', 64))$$, 'a job in a demo workspace');

-- ---- value rules
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256) values (tests.org_id('a'), 'abc')$$, '23514', null, 'a hash that is not 64 hex characters is refused');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256) values (tests.org_id('a'), upper(repeat('a', 64)))$$, '23514', null, 'an upper-case hash is refused (lower-case hex only)');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, status) values (tests.org_id('a'), repeat('a', 64), 'done')$$, '23514', null, 'an unknown status is refused');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, total_rows) values (tests.org_id('a'), repeat('a', 64), -1)$$, '23514', null, 'negative counts are refused');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, total_rows) values (tests.org_id('a'), repeat('a', 64), 10001)$$, '23514', null, 'more than 10,000 rows is refused');
select lives_ok($$insert into public.import_jobs (organization_id, file_sha256, total_rows) values (tests.org_id('a'), repeat('d', 64), 10000)$$, 'exactly 10,000 rows is allowed');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, total_rows, status, imported_rows, rejected_rows, completed_at) values (tests.org_id('a'), repeat('a', 64), 5, 'committed', 4, 2, now())$$, '23514', null, 'imported plus rejected cannot exceed the total');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, total_rows, imported_rows) values (tests.org_id('a'), repeat('a', 64), 5, 5)$$, '23514', null, 'a preview cannot claim imported rows');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, status) values (tests.org_id('a'), repeat('a', 64), 'committed')$$, '23514', null, 'a finished job must have a completion time');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, completed_at) values (tests.org_id('a'), repeat('a', 64), now())$$, '23514', null, 'a preview cannot have a completion time');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, error_summary) values (tests.org_id('a'), repeat('a', 64), '"text"'::jsonb)$$, '23514', null, 'the error summary must be a list or an object');
select lives_ok($$insert into public.import_jobs (organization_id, file_sha256, error_summary) values (tests.org_id('a'), repeat('e', 64), '[{"row": 2, "code": "EMAIL_INVALID"}, {"row": 9, "code": "NAME_REQUIRED"}]'::jsonb)$$, 'a summary of row numbers and codes is stored');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, error_summary) values (tests.org_id('a'), repeat('a', 64), (select jsonb_agg(jsonb_build_object('row', n, 'code', 'EMAIL_INVALID')) from generate_series(1, 1000) n))$$, '23514', null, 'a summary over 20,000 bytes is refused (the cap)');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256, expires_at) values (tests.org_id('a'), repeat('a', 64), now() - interval '1 minute')$$, '23514', null, 'a job cannot expire before it is created');
select throws_ok($$insert into public.import_jobs (organization_id, file_sha256) values (gen_random_uuid(), repeat('a', 64))$$, '23503', null, 'a job needs a real organization');

-- ---- state and immutability
select lives_ok($$update public.import_jobs set status = 'committed', imported_rows = 8, rejected_rows = 2, completed_at = now() where id = 'f1000000-0000-4000-8000-000000000001'$$, 'a preview becomes committed with its counts');
select is(tests.sqlstate_of($$update public.import_jobs set imported_rows = 1 where id = 'f1000000-0000-4000-8000-000000000001'$$), 'OD409', 'a committed job cannot change again');
select is(tests.sqlstate_of($$update public.import_jobs set status = 'failed' where id = 'f1000000-0000-4000-8000-000000000001'$$), 'OD409', 'and cannot become failed');
select throws_ok($$update public.import_jobs set file_sha256 = repeat('f', 64) where id = 'f1000000-0000-4000-8000-000000000002'$$, null, null, 'the file hash never changes');
select throws_ok($$update public.import_jobs set organization_id = tests.org_id('a') where id = 'f1000000-0000-4000-8000-000000000002'$$, null, null, 'a job cannot move to another organization');
select throws_ok($$update public.import_jobs set total_rows = 99 where id = 'f1000000-0000-4000-8000-000000000002'$$, null, null, 'the total row count never changes after the preview');
select throws_ok($$update public.import_jobs set created_by = tests.uid('a_owner') where id = 'f1000000-0000-4000-8000-000000000002'$$, null, null, 'the creator never changes');
select lives_ok($$update public.import_jobs set status = 'failed', completed_at = now(), error_summary = '[{"row": 0, "code": "COMMIT_FAILED"}]' where id = 'f1000000-0000-4000-8000-000000000002'$$, 'a preview can fail');

-- ---- clients: read only, own organization only
select tests.act_as('a_member');
select is((select count(*) from public.import_jobs), 3::bigint, 'a member of organization A sees organization A''s jobs (and no other organization''s)');
select is((select count(*) from public.import_jobs where organization_id <> tests.org_id('a')), 0::bigint, 'none of them belongs to another organization');
select is(tests.denied($$insert into public.import_jobs (organization_id, file_sha256) values (tests.org_id('a'), repeat('a', 64))$$), true, 'a member cannot insert a job');
select is(tests.denied($$update public.import_jobs set status = 'committed', imported_rows = 5 where organization_id = tests.org_id('a')$$), true, 'cannot set imported_rows or status directly');
select is(tests.denied($$delete from public.import_jobs where organization_id = tests.org_id('a')$$), true, 'cannot delete a job');
select tests.reset();
select tests.act_as('a_owner');
select is(tests.denied($$update public.import_jobs set status = 'committed' where organization_id = tests.org_id('a')$$), true, 'not even an owner can write the table directly');
select tests.reset();
select tests.act_as('b_viewer');
select is((select count(*) from public.import_jobs), 1::bigint, 'a viewer reads their own organization''s jobs');
select is((select count(*) from public.import_jobs where organization_id = tests.org_id('a')), 0::bigint, 'organization A''s jobs are invisible to organization B (cross-tenant read fails)');
select tests.reset();
select tests.act_as('outsider');
select is((select count(*) from public.import_jobs), 0::bigint, 'a user who belongs to no organization sees no jobs');
select tests.reset();
select tests.act_as_anon();
select is(tests.denied($$select count(*) from public.import_jobs$$), true, 'a signed-out caller cannot read the table at all');
select tests.reset();

-- ---- who may commit
select tests.act_as('a_member');
reset role; -- the caller's identity (JWT claims) stays; only the function's owner may call the helper
select is(private.can_commit_import_job('f1000000-0000-4000-8000-000000000001'), true, 'the creator (a member) may commit');
select tests.reset();
select tests.act_as('a_owner');
reset role; -- the caller's identity (JWT claims) stays; only the function's owner may call the helper
select is(private.can_commit_import_job('f1000000-0000-4000-8000-000000000001'), true, 'an owner may commit someone else''s job');
select tests.reset();
select tests.act_as('a_viewer');
reset role; -- the caller's identity (JWT claims) stays; only the function's owner may call the helper
select is(private.can_commit_import_job('f1000000-0000-4000-8000-000000000001'), false, 'a viewer may not');
select tests.reset();
select tests.act_as('b_owner');
reset role; -- the caller's identity (JWT claims) stays; only the function's owner may call the helper
select is(private.can_commit_import_job('f1000000-0000-4000-8000-000000000001'), false, 'an owner of another organization may not');
select tests.reset();

-- ---- the repeat-protection lookup uses the index (EXPLAIN is recorded in docs/PROGRESS.md)
insert into public.import_jobs (organization_id, file_sha256, total_rows) select tests.org_id('a'), pg_catalog.encode(pg_catalog.sha256(n::text::bytea), 'hex'), 1 from generate_series(1, 400) n;
analyze public.import_jobs;
select ok(
  strpos(tests.explain_text($q$select id from public.import_jobs where organization_id = tests.org_id('a') and file_sha256 = repeat('a', 64) and created_at > now() - interval '10 minutes' order by created_at desc limit 1$q$), 'import_jobs_org_file_created_idx') > 0
  or strpos(tests.explain_text($q$select id from public.import_jobs where organization_id = tests.org_id('a') and file_sha256 = repeat('a', 64)$q$), 'import_jobs_org_file_created_idx') > 0,
  'the same-file lookup for an organization is served by the (organization_id, file_sha256, created_at) index');

-- ---- demo cap
update private.app_limits set value = 1 where key = 'demo_cap_import_jobs';
select is(tests.sqlstate_of($$insert into public.import_jobs (organization_id, file_sha256) values (tests.org_id('g1'), repeat('9', 64))$$), 'OD429', 'a demo workspace cannot exceed the import job cap');
select lives_ok($$insert into public.import_jobs (organization_id, file_sha256) values (tests.org_id('a'), repeat('9', 64))$$, 'a real workspace has no cap');
update private.app_limits set value = 10 where key = 'demo_cap_import_jobs';

-- ---- expiry cleanup
insert into public.import_jobs (id, organization_id, file_sha256, total_rows, expires_at, created_at) values
  ('f2000000-0000-4000-8000-000000000001', tests.org_id('a'), repeat('1', 64), 3, now() - interval '1 minute', now() - interval '2 hours'),
  ('f2000000-0000-4000-8000-000000000002', tests.org_id('a'), repeat('2', 64), 3, now() + interval '30 minutes', now() - interval '30 minutes');
select is((select expired from public.cleanup_expire_import_previews()), 1, 'cleanup marks only the preview past its expiry');
select is((select status from public.import_jobs where id = 'f2000000-0000-4000-8000-000000000001') || '|' || (select status from public.import_jobs where id = 'f2000000-0000-4000-8000-000000000002'), 'expired|previewed', 'the other preview is still usable');
select is((select removed from public.cleanup_expire_import_previews(interval '0 seconds')), 1, 'expired previews are removed once past the retention');
select is((select count(*) from public.import_jobs where id = 'f2000000-0000-4000-8000-000000000001'), 0::bigint, 'it is gone');
select is((select count(*) from public.import_jobs where status = 'committed'), 1::bigint, 'committed jobs are never removed by cleanup');
select is(has_function_privilege('authenticated', 'public.cleanup_expire_import_previews(interval)', 'execute'), false, 'clients cannot call the cleanup');
select is(has_function_privilege('authenticated', 'private.can_commit_import_job(uuid)', 'execute'), false, 'clients cannot call the commit-rule helper directly');
select is(has_function_privilege('service_role', 'public.cleanup_expire_import_previews(interval)', 'execute'), true, 'the cleanup job can');

select * from finish();
rollback;
