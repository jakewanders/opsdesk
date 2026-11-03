-- pgTAP tests for public.record_import_preview (SIT-231): who may record a preview, repeat protection (the same file returns the same
-- job), the stored summary, the demo capacity it reports, and what it refuses.
begin;
select plan(30);
select tests.create_fixtures();

create function public.zz_rec(sha text, total integer default 5, rejected integer default 1, summary jsonb default '[]'::jsonb, org uuid default tests.org_id('a')) returns jsonb language sql as $$
  select public.record_import_preview(org, sha, total, rejected, summary)
$$;
grant execute on function public.zz_rec(text, integer, integer, jsonb, uuid) to authenticated;

select has_function('public', 'record_import_preview', array['uuid', 'text', 'integer', 'integer', 'jsonb'], 'the function exists');
select is(has_function_privilege('anon', 'public.record_import_preview(uuid,text,integer,integer,jsonb)', 'execute'), false, 'a signed-out caller cannot execute it');
select is(has_function_privilege('authenticated', 'public.record_import_preview(uuid,text,integer,integer,jsonb)', 'execute'), true, 'signed-in callers can');
select is((select prosecdef from pg_proc where oid = 'public.record_import_preview(uuid,text,integer,integer,jsonb)'::regprocedure), true, 'it is SECURITY DEFINER');
select is((select proconfig::text from pg_proc where oid = 'public.record_import_preview(uuid,text,integer,integer,jsonb)'::regprocedure), '{"search_path=\"\""}', 'with the search path pinned');

-- ---- a member records a preview
select tests.act_as('a_member');
select is((select (public.zz_rec(repeat('a', 64), 5, 1, '{"errors":[{"row":3,"field":"email","code":"INVALID_FORMAT"}],"truncated":false}'))->>'status'), 'previewed', 'a member records a preview');
select is((select (public.zz_rec(repeat('a', 64)))->>'reused'), 'true', 'the same file again is the same job (reused)');
select is((select count(*) from public.import_jobs where file_sha256 = repeat('a', 64)), 1::bigint, 'and no second job was created');
select is((select (public.zz_rec(repeat('a', 64)))->>'id'), (select id::text from public.import_jobs where file_sha256 = repeat('a', 64)), 'with the same id');
select is((select (public.zz_rec(repeat('b', 64)))->>'reused'), 'false', 'a different file is a new job');
select is((select created_by from public.import_jobs where file_sha256 = repeat('a', 64)), tests.uid('a_member'), 'the job belongs to the caller');
select is((select error_summary->'errors'->0->>'code' from public.import_jobs where file_sha256 = repeat('a', 64)), 'INVALID_FORMAT', 'the summary holds the row, field and code');
select is((select rejected_rows || '/' || total_rows from public.import_jobs where file_sha256 = repeat('a', 64)), '1/5', 'with the counts');
select is((select (public.zz_rec(repeat('c', 64)))->'demoRemaining'), 'null'::jsonb, 'a real workspace reports no demo capacity');
select tests.reset();

-- ---- the window
select tests.act_as('a_member');
reset role;
alter table public.import_jobs disable trigger import_jobs_protect_columns; -- the test moves time back; the column guard would refuse
update public.import_jobs set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where file_sha256 = repeat('a', 64);
alter table public.import_jobs enable trigger import_jobs_protect_columns;
select tests.act_as('a_member');
select is((select (public.zz_rec(repeat('a', 64)))->>'reused'), 'false', 'a file previewed over an hour ago gets a new job');
reset role;
update public.import_jobs set status = 'committed', imported_rows = 4, rejected_rows = 1, completed_at = now() where file_sha256 = repeat('b', 64);
select tests.act_as('a_member');
select is((select (public.zz_rec(repeat('b', 64)))->>'status'), 'committed', 'a file that was just imported returns that finished job (no second import)');
select tests.reset();

-- ---- who is refused
select tests.act_as('a_viewer');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('d', 64))$$), 'OD403', 'a viewer cannot record a preview');
select tests.reset();
select tests.act_as('b_owner');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('d', 64))$$), 'OD404', 'a member of another workspace gets "not found"');
select tests.reset();
select tests.act_as('outsider');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('d', 64))$$), 'OD404', 'a user in no workspace gets "not found"');
select tests.reset();
select tests.act_as_anon();
select is(tests.denied($$select public.zz_rec(repeat('d', 64))$$), true, 'a signed-out caller is denied');
select tests.reset();
select tests.act_as('a_owner');
select is(tests.sqlstate_of($$select public.zz_rec('nothex')$$), 'OD422', 'a malformed hash is refused');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('e', 64), 3, 4)$$), '23514', 'more rejected rows than rows is refused by the table rules');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('e', 64), 10001)$$), '23514', 'more than 10,000 rows is refused');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('e', 64), 3, 1, (select jsonb_agg(jsonb_build_object('row', n, 'code', 'EMAIL_INVALID')) from generate_series(1, 1000) n))$$), '23514', 'an oversized summary is refused');
select tests.reset();

-- ---- demo workspaces
select tests.act_as('g1');
select is((select (public.zz_rec(repeat('f', 64), 5, 0, '[]', tests.org_id('g1')))->>'status'), 'previewed', 'a guest can preview in their own demo');
select is((select ((public.zz_rec(repeat('f', 64), 5, 0, '[]', tests.org_id('g1')))->>'demoRemaining')::integer), 50, 'and is told how many customers still fit under the demo cap');
select tests.reset();
insert into public.customers (organization_id, display_name) select tests.org_id('g1'), 'Demo customer ' || n from generate_series(1, 3) n;
select tests.act_as('g1');
select is((select ((public.zz_rec(repeat('f', 64), 5, 0, '[]', tests.org_id('g1')))->>'demoRemaining')::integer), 47, 'the remaining count follows the customers already there');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('f', 64), 5, 0, '[]', tests.org_id('g2'))$$), 'OD404', 'a guest cannot record into someone else''s demo');
select tests.reset();
select tests.act_as('g3');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('f', 64), 5, 0, '[]', tests.org_id('expired'))$$), 'OD403', 'an expired demo cannot record a preview');
select tests.reset();

-- ---- the demo cap on jobs still applies
update private.app_limits set value = 1 where key = 'demo_cap_import_jobs';
select tests.act_as('g1');
select is(tests.sqlstate_of($$select public.zz_rec(repeat('9', 64), 5, 0, '[]', tests.org_id('g1'))$$), 'OD429', 'a demo workspace past its import job cap is refused with the cap error');
select tests.reset();
update private.app_limits set value = 10 where key = 'demo_cap_import_jobs';

select * from finish();
rollback;
