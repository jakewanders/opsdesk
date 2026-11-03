-- pgTAP tests for public.commit_customer_import (SIT-239): who may commit, exactly-once (a second commit returns the stored result),
-- chunking and the failed-chunk rule, skipped duplicates, the demo cap, the job moving previewed -> committed | failed, and activity.
begin;
select plan(47);
select tests.create_fixtures();

-- n valid rows starting at spreadsheet row `first`; names "<prefix> <k>", e-mails "<prefix>-<k>@x.test" (or null when with_email is false)
create function public.zz_rows(n integer, prefix text, first integer default 2, with_email boolean default true) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'src_row', first + k - 1, 'type', 'person', 'display_name', prefix || ' ' || k,
    'company_name', null, 'email', case when with_email then lower(prefix) || '-' || k || '@x.test' else null end,
    'phone', null, 'website', null, 'status', 'lead', 'source', 'other', 'tags', '[]'::jsonb, 'notes', null) order by k), '[]'::jsonb)
  from generate_series(1, n) k
$$;
create function public.zz_job(sha text, total integer, rejected integer default 0, org uuid default tests.org_id('a')) returns uuid language sql as $$
  select (public.record_import_preview(org, sha, total, rejected, '{"errors":[{"row":9,"field":"email","code":"INVALID_EMAIL"}],"truncated":false,"byCode":{"INVALID_EMAIL":1}}'::jsonb)->>'id')::uuid
$$;
grant execute on function public.zz_rows(integer, text, integer, boolean), public.zz_job(text, integer, integer, uuid) to authenticated;

select has_function('public', 'commit_customer_import', array['uuid', 'jsonb'], 'the function exists');
select is(has_function_privilege('anon', 'public.commit_customer_import(uuid,jsonb)', 'execute'), false, 'a signed-out caller cannot execute it');
select is(has_function_privilege('authenticated', 'public.commit_customer_import(uuid,jsonb)', 'execute'), true, 'signed-in callers can');
select is((select prosecdef from pg_proc where oid = 'public.commit_customer_import(uuid,jsonb)'::regprocedure), true, 'it is SECURITY DEFINER');
select is((select proconfig::text from pg_proc where oid = 'public.commit_customer_import(uuid,jsonb)'::regprocedure), '{"search_path=\"\""}', 'with the search path pinned');

-- ---- a clean import
select tests.act_as('a_member');
create temp table t_ids (k text primary key, id uuid);
grant all on t_ids to authenticated;
insert into t_ids values ('clean', public.zz_job(repeat('1', 64), 5, 1));
select is((select (public.commit_customer_import((select id from t_ids where k = 'clean'), public.zz_rows(4, 'Clean')))->>'imported')::integer, 4, 'four valid rows are imported');
select is((select count(*) from public.customers where organization_id = tests.org_id('a') and display_name like 'Clean %'), 4::bigint, 'four customers exist');
select is((select count(*) from public.customers where display_name like 'Clean %' and created_by = tests.uid('a_member')), 4::bigint, 'created by the caller');
select is((select status || '|' || imported_rows || '|' || rejected_rows || '|' || total_rows || '|' || (completed_at is not null) from public.import_jobs where id = (select id from t_ids where k = 'clean')), 'committed|4|1|5|true', 'the job is committed with its counts');
select is((select error_summary->'errors'->0->>'code' from public.import_jobs where id = (select id from t_ids where k = 'clean')), 'INVALID_EMAIL', 'the preview''s error list is kept on the job');
select is((select error_summary->'result'->>'imported' from public.import_jobs where id = (select id from t_ids where k = 'clean')), '4', 'and the result is recorded');
select tests.reset();
select is((select count(*) from public.activity_events where entity_type = 'customer' and action = 'created' and summary like '%Clean %'), 4::bigint, 'each customer has its created event');
select is((select count(*) from public.activity_events where action = 'imported' and entity_id = (select id from t_ids where k = 'clean')), 1::bigint, 'and one summary event for the import');

-- ---- exactly once
select tests.act_as('a_member');
select is((select (public.commit_customer_import((select id from t_ids where k = 'clean'), public.zz_rows(4, 'Clean')))->>'replayed'), 'true', 'a second commit of the same job is a replay');
select is((select (public.commit_customer_import((select id from t_ids where k = 'clean'), '[]'::jsonb))->>'imported'), '4', 'it reports the original result');
select is((select count(*) from public.customers where display_name like 'Clean %'), 4::bigint, 'and no customer was written twice');
select tests.reset();

-- ---- who may commit
select tests.act_as('a_admin');
insert into t_ids values ('admins', public.zz_job(repeat('2', 64), 3));
select tests.reset();
select tests.act_as('a_member');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'admins'), public.zz_rows(3, 'Nope'))$$), 'OD403', 'a member cannot finish an import an admin started');
select tests.reset();
select tests.act_as('a_owner');
select is((select (public.commit_customer_import((select id from t_ids where k = 'admins'), public.zz_rows(3, 'Owned')))->>'imported')::integer, 3, 'an owner can finish someone else''s import');
select tests.reset();
select tests.act_as('a_member');
insert into t_ids values ('viewer', public.zz_job(repeat('3', 64), 2));
select tests.reset();
select tests.act_as('a_viewer');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), public.zz_rows(2, 'View'))$$), 'OD403', 'a viewer cannot commit');
select tests.reset();
select tests.act_as('b_owner');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), public.zz_rows(2, 'Other'))$$), 'OD404', 'another workspace''s owner gets "not found"');
select tests.reset();
select tests.act_as('outsider');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), public.zz_rows(2, 'Out'))$$), 'OD404', 'a user in no workspace gets "not found"');
select tests.reset();
select tests.act_as_anon();
select is(tests.denied($$select public.commit_customer_import(gen_random_uuid(), '[]'::jsonb)$$), true, 'a signed-out caller is denied');
select tests.reset();
select tests.act_as('a_member');
select is(tests.sqlstate_of($$select public.commit_customer_import(gen_random_uuid(), '[]'::jsonb)$$), 'OD404', 'an unknown job is "not found"');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), public.zz_rows(3, 'Many'))$$), 'OD422', 'more rows than the preview found is refused');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), '{"a":1}'::jsonb)$$), 'OD422', 'rows that are not a list are refused');
select is((select status from public.import_jobs where id = (select id from t_ids where k = 'viewer')), 'previewed', 'a refused commit leaves the job previewed');
select tests.reset();

-- ---- expired preview
alter table public.import_jobs disable trigger import_jobs_protect_columns;
update public.import_jobs set expires_at = now() - interval '1 minute', created_at = now() - interval '2 hours' where id = (select id from t_ids where k = 'viewer');
alter table public.import_jobs enable trigger import_jobs_protect_columns;
select tests.act_as('a_member');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'viewer'), public.zz_rows(2, 'Late'))$$), 'OD409', 'an expired preview cannot be committed');
select tests.reset();

-- ---- duplicates are skipped, not failed
insert into public.customers (organization_id, display_name, email) values (tests.org_id('a'), 'Already Here', 'dupe-1@x.test');
select tests.act_as('a_member');
insert into t_ids values ('dupes', public.zz_job(repeat('4', 64), 4));
select is((select (public.commit_customer_import((select id from t_ids where k = 'dupes'),
  (select public.zz_rows(3, 'Dupe') || jsonb_build_array(jsonb_build_object('src_row', 20, 'type', 'person', 'display_name', 'Dupe Twin', 'email', 'dupe-2@x.test', 'tags', '[]'::jsonb, 'status', 'lead', 'source', 'other')))))::text),
  (select (jsonb_build_object('importJobId', (select id from t_ids where k = 'dupes'), 'status', 'committed', 'replayed', false, 'total', 4, 'imported', 2, 'rejected', 0, 'skippedDuplicates', 2, 'failedChunks', '[]'::jsonb, 'failedRows', 0, 'demoCapReached', false, 'notImportedDemoCap', 0))::text),
  'an e-mail already in the workspace and one repeated in the same file are skipped and counted');
select is((select count(*) from public.customers where email = 'dupe-2@x.test'), 1::bigint, 'the repeated address was imported once');
select is((select count(*) from public.import_jobs j, jsonb_array_elements(j.error_summary->'extra') e where j.id = (select id from t_ids where k = 'dupes') and e->>'code' = 'DUPLICATE_SKIPPED'), 2::bigint, 'the skipped rows are listed by number on the job');
select tests.reset();

-- ---- chunking: 250 rows are three chunks
select tests.act_as('a_member');
insert into t_ids values ('big', public.zz_job(repeat('5', 64), 250));
select is((select (public.commit_customer_import((select id from t_ids where k = 'big'), public.zz_rows(250, 'Big', 2, false)))->>'imported')::integer, 250, '250 rows are imported');
select is((select count(*) from public.customers where display_name like 'Big %'), 250::bigint, 'all of them exist');
select is((select error_summary->'result'->'failedChunks' from public.import_jobs where id = (select id from t_ids where k = 'big')), '[]'::jsonb, 'with no failed chunk');
select tests.reset();

-- ---- a failure in chunk 3: earlier chunks stay, later chunks still run, the failed chunk is reported
create function public.zz_import_boom() returns trigger language plpgsql as $$ begin
  if new.display_name = 'BOOM' then raise exception 'forced failure'; end if;
  return new;
end $$;
create trigger zz_import_boom before insert on public.customers for each row execute function public.zz_import_boom();
select tests.act_as('a_member');
insert into t_ids values ('boom', public.zz_job(repeat('6', 64), 450));
select is((select (public.commit_customer_import((select id from t_ids where k = 'boom'),
  (select jsonb_agg(case when (r->>'src_row')::integer = 250 then jsonb_set(r, '{display_name}', '"BOOM"') else r end order by (r->>'src_row')::integer)
     from jsonb_array_elements(public.zz_rows(450, 'Boom', 2, false)) r)))->>'imported')::integer, 350, 'a failure in one chunk imports the other 350');
select is((select error_summary->'result'->>'failedChunks' from public.import_jobs where id = (select id from t_ids where k = 'boom')), '[3]', 'chunk 3 (rows 201 to 300) is reported as failed');
select is((select error_summary->'result'->>'failedRows' from public.import_jobs where id = (select id from t_ids where k = 'boom')), '100', 'with its 100 rows');
select is((select count(*) from public.customers where display_name like 'Boom %'), 350::bigint, 'chunks 1, 2 and 4 are committed (350 rows)');
select is((select count(*) from public.customers where display_name = 'BOOM'), 0::bigint, 'nothing from the failed chunk was kept');
select is((select status from public.import_jobs where id = (select id from t_ids where k = 'boom')), 'committed', 'the job is committed (some rows went in)');
select is((select count(*) from public.import_jobs j, jsonb_array_elements(j.error_summary->'extra') e where j.id = (select id from t_ids where k = 'boom') and e->>'code' = 'COMMIT_FAILED'), 100::bigint, 'the failed rows are listed by number');
insert into t_ids values ('allfail', public.zz_job(repeat('7', 64), 1));
select is((select (public.commit_customer_import((select id from t_ids where k = 'allfail'), jsonb_build_array(jsonb_build_object('src_row', 2, 'type', 'person', 'display_name', 'BOOM', 'tags', '[]'::jsonb, 'status', 'lead', 'source', 'other'))))->>'status'), 'failed', 'when nothing could be imported the job is failed');
select tests.reset();
drop trigger zz_import_boom on public.customers;

-- ---- demo workspaces
select tests.act_as('g1');
insert into t_ids values ('demo', public.zz_job(repeat('8', 64), 8, 0, tests.org_id('g1')));
select tests.reset();
update private.app_limits set value = 5 where key = 'demo_cap_customers';
select tests.act_as('g1');
select is((select (public.commit_customer_import((select id from t_ids where k = 'demo'), public.zz_rows(8, 'Demo')))->>'imported')::integer, 5, 'a demo workspace imports up to its cap');
select is((select error_summary->'result'->>'notImportedDemoCap' || '|' || (error_summary->'result'->>'demoCapReached') from public.import_jobs where id = (select id from t_ids where k = 'demo')), '3|true', 'and reports the three rows that did not fit');
select is((select count(*) from public.customers where organization_id = tests.org_id('g1') and display_name like 'Demo %'), 5::bigint, 'exactly five were written');
select is((select status from public.import_jobs where id = (select id from t_ids where k = 'demo')), 'committed', 'the job is committed with the partial result');
select tests.reset();
update private.app_limits set value = 50 where key = 'demo_cap_customers';
select tests.act_as('g2');
select is(tests.sqlstate_of($$select public.commit_customer_import((select id from t_ids where k = 'demo'), '[]'::jsonb)$$), 'OD404', 'another guest cannot touch this demo''s job');
select tests.reset();

-- ---- the job is locked while it commits (the second caller waits, then replays)
select is((select count(*) from pg_proc where oid = 'public.commit_customer_import(uuid,jsonb)'::regprocedure and prosrc like '%for update%'), 1::bigint, 'the function takes a row lock on the job');

select * from finish();
rollback;
