-- pgTAP tests for public.customers (SIT-208, PRD 6.2, US-03): constraints, RLS by role, cap, immutability, activity, seed.
begin;
select plan(90);
select tests.create_fixtures();
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

-- ---- shape
select has_table('public', 'customers', 'the table exists');
select is((select relrowsecurity from pg_class where oid = 'public.customers'::regclass), true, 'row level security is on');
select is((select count(*) from pg_constraint where conrelid = 'public.customers'::regclass and conname = 'customers_org_id_key' and contype = 'u'), 1::bigint, 'unique (organization_id, id) exists for composite foreign keys');
select is((select count(*) from pg_constraint where conrelid = 'public.customers'::regclass and contype = 'u' and pg_get_constraintdef(oid) ilike '%email%'), 0::bigint, 'email is not unique (a duplicate is only a warning)');
select is((select array_agg(indexname::text order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'customers'),
  array['customers_org_archived_updated_idx', 'customers_org_assigned_idx', 'customers_org_created_idx', 'customers_org_id_key', 'customers_org_status_idx', 'customers_pkey', 'customers_search_trgm_idx'], 'the list, status, assignee, created and trigram search indexes exist');
select is((select indexdef like '%(organization_id, archived_at, updated_at DESC)' from pg_indexes where indexname = 'customers_org_archived_updated_idx'), true, 'the list index is newest first per organization');
select is((select indexdef like '%gin_trgm_ops%' from pg_indexes where indexname = 'customers_search_trgm_idx'), true, 'the search index is a trigram index');

select is((select is_generated from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = 'search_text'), 'ALWAYS', 'search_text is a generated column (never written)');
select is((select indexdef like '%(search_text gin_trgm_ops)' from pg_indexes where indexname = 'customers_search_trgm_idx'), true, 'and the trigram index covers it');

-- ---- grants
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'customers' and grantee = 'authenticated'), 'INSERT,SELECT,UPDATE', 'authenticated may select, insert and update, never delete or truncate');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'customers' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds nothing');

-- ---- constraints and normalization (server role)
select lives_ok($$insert into public.customers (id, organization_id, display_name, email) values ('c1000000-0000-4000-8000-000000000001', tests.org_id('a'), '  Acme Plumbing  ', '  Info@ACME.Example.COM ')$$, 'a normal insert works');
select is((select display_name from public.customers where id = 'c1000000-0000-4000-8000-000000000001'), 'Acme Plumbing', 'the name is trimmed');
select is((select email from public.customers where id = 'c1000000-0000-4000-8000-000000000001'), 'info@acme.example.com', 'the e-mail is trimmed and lower-cased');
select is((select type || '/' || status || '/' || source from public.customers where id = 'c1000000-0000-4000-8000-000000000001'), 'person/lead/other', 'defaults: person, lead, other');
select lives_ok($$insert into public.customers (organization_id, display_name, email) values (tests.org_id('a'), 'Twin Email', 'info@acme.example.com')$$, 'the same e-mail may be used twice (no unique constraint)');
select is((select email from (select email from public.customers where display_name = 'Twin Email') s), 'info@acme.example.com', 'and is stored');
select lives_ok($$insert into public.customers (id, organization_id, display_name, email) values ('c1000000-0000-4000-8000-000000000002', tests.org_id('a'), 'No Mail', '   ')$$, 'a blank e-mail is accepted');
select is((select email is null from public.customers where id = 'c1000000-0000-4000-8000-000000000002'), true, 'and stored as null');
select throws_ok($$insert into public.customers (organization_id, display_name) values (tests.org_id('a'), 'x')$$, '23514', null, 'a one-character name is refused');
select throws_ok($$insert into public.customers (organization_id, display_name) values (tests.org_id('a'), '   ')$$, '23514', null, 'a blank name is refused');
select throws_ok($$insert into public.customers (organization_id, display_name) values (tests.org_id('a'), repeat('n', 121))$$, '23514', null, 'a name over 120 characters is refused');
select lives_ok($$insert into public.customers (organization_id, display_name) values (tests.org_id('a'), repeat('n', 120))$$, 'exactly 120 is fine');
select throws_ok($$insert into public.customers (organization_id, display_name, company_name) values (tests.org_id('a'), 'Ok Name', repeat('c', 121))$$, '23514', null, 'a company name over 120 is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, email) values (tests.org_id('a'), 'Bad Mail', 'not-an-email')$$, '23514', null, 'an invalid e-mail is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, email) values (tests.org_id('a'), 'Bad Mail', 'a b@example.com')$$, '23514', null, 'an e-mail with a space is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, phone) values (tests.org_id('a'), 'Long Phone', repeat('1', 41))$$, '23514', null, 'a phone over 40 characters is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, website) values (tests.org_id('a'), 'Bad Site', 'javascript:alert(1)')$$, '23514', null, 'a javascript: website is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, website) values (tests.org_id('a'), 'Bad Site', 'ftp://example.com')$$, '23514', null, 'only http and https websites are accepted');
select lives_ok($$insert into public.customers (organization_id, display_name, website) values (tests.org_id('a'), 'Good Site', 'https://www.example.com/path?a=1')$$, 'an https website is accepted');
select throws_ok($$insert into public.customers (organization_id, display_name, type) values (tests.org_id('a'), 'Bad Type', 'robot')$$, '23514', null, 'an unknown type is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, status) values (tests.org_id('a'), 'Bad Status', 'won')$$, '23514', null, 'an unknown status is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, source) values (tests.org_id('a'), 'Bad Source', 'billboard')$$, '23514', null, 'an unknown source is refused');
select lives_ok($$insert into public.customers (id, organization_id, display_name, tags) values ('c1000000-0000-4000-8000-000000000003', tests.org_id('a'), 'Tagged', array['  vip ', '', 'repeat'])$$, 'tags are trimmed and empty ones dropped');
select is((select tags from public.customers where id = 'c1000000-0000-4000-8000-000000000003'), array['vip', 'repeat'], 'leaving the clean list');
select throws_ok($$insert into public.customers (organization_id, display_name, tags) values (tests.org_id('a'), 'Too Many', array['1','2','3','4','5','6','7','8','9','10','11'])$$, '23514', null, 'more than 10 tags is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, tags) values (tests.org_id('a'), 'Long Tag', array[repeat('t', 31)])$$, '23514', null, 'a tag over 30 characters is refused');
select throws_ok($$insert into public.customers (organization_id, display_name, notes) values (tests.org_id('a'), 'Long Notes', repeat('n', 5001))$$, '23514', null, 'notes over 5,000 characters are refused');
select lives_ok($$insert into public.customers (organization_id, display_name, notes) values (tests.org_id('a'), 'Max Notes', repeat('n', 5000))$$, 'exactly 5,000 is fine');

-- ---- assigned_to must be a member of the same organization
select lives_ok(format('update public.customers set assigned_to = %L where id = ''c1000000-0000-4000-8000-000000000001''', tests.uid('a_member')), 'a member of the organization can be assigned');
select throws_ok(format('update public.customers set assigned_to = %L where id = ''c1000000-0000-4000-8000-000000000001''', tests.uid('b_owner')), '23503', null, 'a member of ANOTHER organization cannot be');
select throws_ok(format('update public.customers set assigned_to = %L where id = ''c1000000-0000-4000-8000-000000000001''', tests.uid('outsider')), '23503', null, 'nor a user with no membership');
select throws_ok(format('update public.customers set assigned_to = %L where id = ''c1000000-0000-4000-8000-000000000001''', gen_random_uuid()), '23503', null, 'nor an unknown user');
delete from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_member');
select is((select assigned_to is null and organization_id = tests.org_id('a') from public.customers where id = 'c1000000-0000-4000-8000-000000000001'), true, 'removing the assignee clears only the assignment (the customer stays in its organization)');
insert into public.memberships (organization_id, user_id, role) values (tests.org_id('a'), tests.uid('a_member'), 'member');

-- ---- RLS by role
select is(tests.visible_count_as('a_owner', 'public.customers', format('organization_id = %L', tests.org_id('a'))) > 0, true, 'members read their organization''s customers');
select is(tests.visible_count_as('b_owner', 'public.customers', format('organization_id = %L', tests.org_id('a'))), 0::bigint, 'another organization''s owner sees none of them');
select is(tests.visible_count_as('outsider', 'public.customers'), 0::bigint, 'a user with no membership sees none');
select is(tests.visible_count_as('a_viewer', 'public.customers', 'id = ''c1000000-0000-4000-8000-000000000001'''), 1::bigint, 'a viewer can read');
select is(tests.denied_as_anon('select * from public.customers'), true, 'a visitor cannot');
select is(tests.rows_changed_as('b_owner', 'update public.customers set status = ''active'' where id = ''c1000000-0000-4000-8000-000000000001'''), 0::bigint, 'a cross-tenant update changes nothing');
select is(tests.denied_as('b_owner', 'delete from public.customers where id = ''c1000000-0000-4000-8000-000000000001'''), true, 'a cross-tenant delete fails');
select is(tests.denied_as('b_owner', format('insert into public.customers (organization_id, display_name) values (%L, ''Into A'')', tests.org_id('a'))), true, 'inserting into another organization fails');
select is(tests.denied_as('a_viewer', format('insert into public.customers (organization_id, display_name) values (%L, ''Viewer Insert'')', tests.org_id('a'))), true, 'a viewer cannot insert');
select is(tests.rows_changed_as('a_viewer', 'update public.customers set status = ''active'' where id = ''c1000000-0000-4000-8000-000000000001'''), 0::bigint, 'nor update');
select is(tests.denied_as('a_viewer', 'delete from public.customers'), true, 'nor delete');
select is(tests.denied_as('a_owner', 'delete from public.customers'), true, 'not even an owner can delete (archive instead)');
select is(tests.denied_as('a_owner', 'truncate public.customers'), true, 'or truncate');
select is(tests.denied_as('a_member', format('insert into public.customers (organization_id, display_name, created_by) values (%L, ''Forged'', %L)', tests.org_id('a'), tests.uid('a_owner'))), true, 'created_by cannot be set to someone else');

-- ---- writers: create, edit, archive, restore, each logging in the same transaction
select tests.act_as('a_member');
insert into public.customers (id, organization_id, display_name, email, notes) values ('c1000000-0000-4000-8000-000000000010', tests.org_id('a'), 'Warehouse Retrofit Co', 'wr@example.com', 'secret boiler note');
select tests.reset();
select is((select created_by from public.customers where id = 'c1000000-0000-4000-8000-000000000010'), tests.uid('a_member'), 'created_by defaults to the caller');
select is((select summary || '|' || action from public.activity_events where entity_id = 'c1000000-0000-4000-8000-000000000010'), 'Sam Member created customer "Warehouse Retrofit Co"|created', 'creating logs a created event with the actor');
select tests.act_as('a_admin');
update public.customers set status = 'active', notes = 'another note' where id = 'c1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select changes from public.activity_events where entity_id = 'c1000000-0000-4000-8000-000000000010' and action = 'updated'), '{"status": {"old": "lead", "new": "active"}, "_content_changed": ["notes"]}'::jsonb, 'editing logs the status change and only the NAME of the notes field');
select tests.act_as('a_owner');
update public.customers set archived_at = now() where id = 'c1000000-0000-4000-8000-000000000010';
select is((select action from public.activity_events where entity_id = 'c1000000-0000-4000-8000-000000000010' order by created_at desc limit 1), 'archived', 'archiving logs an archived event');
update public.customers set archived_at = null where id = 'c1000000-0000-4000-8000-000000000010';
select is((select action from public.activity_events where entity_id = 'c1000000-0000-4000-8000-000000000010' order by created_at desc limit 1), 'restored', 'restoring logs a restored event');
select tests.reset();
select is((select count(*) from public.activity_events where changes::text ~* 'boiler|another note|wr@example'), 0::bigint, 'no note or e-mail text reached the activity log');
select is((select count(*) from public.activity_events where entity_id = 'c1000000-0000-4000-8000-000000000010'), 4::bigint, 'four events for four changes');

-- immutable columns
select is(tests.sqlstate_of_as('a_owner', format('update public.customers set organization_id = %L where id = ''c1000000-0000-4000-8000-000000000010''', tests.org_id('b'))) <> 'ok', true, 'organization_id cannot be changed');
select is(tests.sqlstate_of_as('a_owner', format('update public.customers set created_by = %L where id = ''c1000000-0000-4000-8000-000000000010''', tests.uid('a_owner'))) <> 'ok', true, 'created_by cannot be changed');
select is(tests.sqlstate_of_as('a_owner', 'update public.customers set created_at = now() - interval ''1 year'' where id = ''c1000000-0000-4000-8000-000000000010''') <> 'ok', true, 'created_at cannot be changed');
select is(tests.sqlstate_of_as('a_owner', 'update public.customers set id = gen_random_uuid() where id = ''c1000000-0000-4000-8000-000000000010''') <> 'ok', true, 'id cannot be changed');

-- atomicity
create temp table before_counts as select (select count(*) from public.customers) c, (select count(*) from public.activity_events) e;
do $$ begin begin
  insert into public.customers (organization_id, display_name) values (tests.org_id('a'), 'Doomed');
  raise exception 'forced';
exception when others then null; end; end $$;
select is((select count(*) from public.customers) = (select c from before_counts) and (select count(*) from public.activity_events) = (select e from before_counts), true, 'a failure after an insert removes both the customer and its event');

-- ---- the demo cap: the 51st fails (here lowered to 3 to keep the test small), archived rows count, real organizations are free
update private.app_limits set value = 3 where key = 'demo_cap_customers';
select tests.act_as('g1');
insert into public.customers (organization_id, display_name) select tests.org_id('g1'), 'Demo ' || i from generate_series(1, 3) i;
select throws_ok(format('insert into public.customers (organization_id, display_name) values (%L, ''Demo 4'')', tests.org_id('g1')), 'OD429', null, 'the next demo customer fails with the cap error');
select is(tests.rows_changed(format('update public.customers set archived_at = now() where organization_id = %L', tests.org_id('g1'))), 3::bigint, 'archive all three');
select throws_ok(format('insert into public.customers (organization_id, display_name) values (%L, ''Demo 5'')', tests.org_id('g1')), 'OD429', null, 'archived customers still count toward the cap');
select tests.reset();
update private.app_limits set value = 50 where key = 'demo_cap_customers';
select is((select value from private.app_limits where key = 'demo_cap_customers'), 50, 'the default cap is 50');

-- expired demo: no writes
select is(tests.denied_as('g3', format('insert into public.customers (organization_id, display_name) values (%L, ''Late'')', tests.org_id('expired'))), true, 'an expired demo cannot insert');

-- ---- the seed: exactly 18 customers per demo workspace, fictional, deterministic
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true), ('aa000000-0000-4000-8000-0000000000b2', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot_a as select public.bootstrap_demo_workspace() r;
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000b2', true);
create temp table boot_b as select public.bootstrap_demo_workspace() r;
grant select on boot_a, boot_b to authenticated;
select tests.reset();
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 18::bigint, 'the seed adds exactly 18 customers');
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and archived_at is not null), 3::bigint, 'three of them archived');
select is((select count(distinct status) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 3::bigint, 'with every status represented');
select is((select count(distinct source) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 4::bigint, 'and every source');
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and (email !~ '@example\.com$' or phone !~ '^\(202\) 555-01[0-9]{2}$')), 0::bigint, 'every address is example.com and every phone is in the fictional 555-01xx range');
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and assigned_to is not null), 6::bigint, 'some are assigned to the workspace owner');
select is((select md5(string_agg(display_name || coalesce(company_name, '') || status || source || email, '|' order by display_name)) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)),
  (select md5(string_agg(display_name || coalesce(company_name, '') || status || source || email, '|' order by display_name)) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 'two workspaces get identical content (deterministic)');
select is((select count(distinct id) from public.customers where organization_id in ((select (r ->> 'organization_id')::uuid from boot_a), (select (r ->> 'organization_id')::uuid from boot_b))), 36::bigint, 'with separate ids');
select is((select count(*) from public.activity_events where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and entity_type = 'customer' and actor_user_id is null and summary like 'System created customer%'), 18::bigint, 'the seed logged 18 created events as System');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
select lives_ok($$select public.bootstrap_demo_workspace()$$, 'bootstrapping again');
select tests.reset();
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 18::bigint, 'does not seed twice');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
update public.customers set display_name = 'Edited by guest' where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and display_name = (select min(display_name) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a));
select lives_ok(format('select public.reset_demo_workspace(%L)', (select r ->> 'organization_id' from boot_a)), 'the guest resets their demo');
select tests.reset();
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 18::bigint, 'after a reset there are 18 customers again (not 36)');
select is((select count(*) from public.customers where display_name = 'Edited by guest'), 0::bigint, 'and the guest''s edit is gone');
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 18::bigint, 'the other guest''s workspace was not touched');

select * from finish();
rollback;
