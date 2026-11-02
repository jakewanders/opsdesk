-- pgTAP tests for public.tasks (SIT-220, PRD 6.2, 6.4, US-05).
begin;
select plan(81);
select tests.create_fixtures();
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer'),
  ('c1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'Globex Customer');
insert into public.opportunities (id, organization_id, customer_id, title) values
  ('d1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Acme Deal'),
  ('d1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'c1000000-0000-4000-8000-0000000000b1', 'Globex Deal');

-- ---- shape
select has_table('public', 'tasks', 'the table exists');
select is((select relrowsecurity from pg_class where oid = 'public.tasks'::regclass), true, 'row level security is on');
select is((select count(*) from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_org_id_key' and contype = 'u'), 1::bigint, 'unique (organization_id, id) exists');
select is((select count(*) from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname in ('tasks_org_status_due_idx', 'tasks_org_assigned_idx')), 2::bigint, 'the (org, status, due date) and (org, assignee) indexes exist');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'tasks' and grantee = 'authenticated'), 'INSERT,SELECT,UPDATE', 'authenticated may select, insert and update, never delete');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'tasks' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds nothing');

-- ---- defaults and normalization
select lives_ok($$insert into public.tasks (id, organization_id, title) values ('e1000000-0000-4000-8000-000000000001', tests.org_id('a'), '  Call the client ')$$, 'a minimal insert works');
select is((select title || '|' || status || '|' || priority || '|' || (completed_at is null)::text from public.tasks where id = 'e1000000-0000-4000-8000-000000000001'), 'Call the client|todo|medium|true', 'trimmed title, status todo, priority medium, not completed');

-- ---- constraints
select throws_ok($$insert into public.tasks (organization_id, title) values (tests.org_id('a'), 'x')$$, '23514', null, 'a one-character title is refused');
select throws_ok($$insert into public.tasks (organization_id, title) values (tests.org_id('a'), repeat('t', 161))$$, '23514', null, 'a title over 160 is refused');
select lives_ok($$insert into public.tasks (organization_id, title) values (tests.org_id('a'), repeat('t', 160))$$, 'exactly 160 is fine');
select lives_ok($$insert into public.tasks (organization_id, title) values (tests.org_id('a'), 'ab')$$, 'exactly 2 is fine');
select throws_ok($$insert into public.tasks (organization_id, title, description) values (tests.org_id('a'), 'Ok title', repeat('d', 5001))$$, '23514', null, 'a description over 5,000 is refused');
select throws_ok($$insert into public.tasks (organization_id, title, status) values (tests.org_id('a'), 'Ok title', 'open')$$, '23514', null, 'an unknown status is refused');
select throws_ok($$insert into public.tasks (organization_id, title, priority) values (tests.org_id('a'), 'Ok title', 'critical')$$, '23514', null, 'an unknown priority is refused');
select lives_ok($$insert into public.tasks (organization_id, title, status, priority, due_date) select tests.org_id('a'), 'S ' || s, s, 'urgent', '2026-03-09' from unnest(array['todo', 'in_progress', 'blocked', 'done']) s$$, 'all four statuses are accepted');
select throws_ok($$insert into public.tasks (organization_id, title, due_date) values (tests.org_id('a'), 'Bad date', '2026-02-30')$$, '22008', null, 'an impossible due date is refused');

-- ---- completed_at belongs to the database
select is((select completed_at is not null from public.tasks where title = 'S done'), true, 'a task inserted as done is stamped completed');
select is((select completed_at is null from public.tasks where title = 'S blocked'), true, 'an open task has no completion time');
insert into public.tasks (id, organization_id, title, completed_at) values ('e1000000-0000-4000-8000-000000000002', tests.org_id('a'), 'Spoof insert', '2001-01-01');
select is((select completed_at is null from public.tasks where id = 'e1000000-0000-4000-8000-000000000002'), true, 'a completed_at sent with an open task is ignored');
insert into public.tasks (id, organization_id, title, status, completed_at) values ('e1000000-0000-4000-8000-000000000003', tests.org_id('a'), 'Spoof done', 'done', '2001-01-01');
select is((select completed_at > now() - interval '1 minute' from public.tasks where id = 'e1000000-0000-4000-8000-000000000003'), true, 'a back-dated completed_at on a done task is replaced with now');
update public.tasks set status = 'done' where id = 'e1000000-0000-4000-8000-000000000001';
select is((select completed_at is not null from public.tasks where id = 'e1000000-0000-4000-8000-000000000001'), true, 'finishing a task stamps completed_at');
create temp table first_done as select completed_at c from public.tasks where id = 'e1000000-0000-4000-8000-000000000001';
update public.tasks set title = 'Call the client today', completed_at = '2001-01-01' where id = 'e1000000-0000-4000-8000-000000000001';
select is((select completed_at = (select c from first_done) from public.tasks where id = 'e1000000-0000-4000-8000-000000000001'), true, 'editing a done task, even with a forged completed_at, keeps the original');
update public.tasks set status = 'in_progress' where id = 'e1000000-0000-4000-8000-000000000001';
select is((select completed_at is null from public.tasks where id = 'e1000000-0000-4000-8000-000000000001'), true, 'reopening clears completed_at');
update public.tasks set completed_at = now() where id = 'e1000000-0000-4000-8000-000000000001';
select is((select completed_at is null from public.tasks where id = 'e1000000-0000-4000-8000-000000000001'), true, 'setting completed_at by hand on an open task changes nothing');

-- ---- composite foreign keys: same tenant only
select lives_ok($$insert into public.tasks (organization_id, title, customer_id, opportunity_id) values (tests.org_id('a'), 'Linked', 'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1')$$, 'a task can link a customer and a deal of its own organization');
select throws_ok($$insert into public.tasks (organization_id, title, customer_id) values (tests.org_id('a'), 'Cross customer', 'c1000000-0000-4000-8000-0000000000b1')$$, '23503', null, 'a customer of another organization is refused');
select throws_ok($$insert into public.tasks (organization_id, title, opportunity_id) values (tests.org_id('a'), 'Cross deal', 'd1000000-0000-4000-8000-0000000000b1')$$, '23503', null, 'a deal of another organization is refused');
select throws_ok($$insert into public.tasks (organization_id, title, customer_id) values (tests.org_id('a'), 'Unknown customer', gen_random_uuid())$$, '23503', null, 'an unknown customer is refused');
select throws_ok($$insert into public.tasks (organization_id, title, customer_id) values (tests.org_id('b'), 'Reverse', 'c1000000-0000-4000-8000-0000000000a1')$$, '23503', null, 'and so is the reverse');
select throws_ok($$update public.tasks set opportunity_id = 'd1000000-0000-4000-8000-0000000000b1' where title = 'Linked'$$, '23503', null, 'moving a task to another organization''s deal is refused');
select lives_ok($$update public.tasks set customer_id = null, opportunity_id = null where title = 'Linked'$$, 'links can be cleared');
select lives_ok(format('update public.tasks set assigned_to = %L where title = ''Linked''', tests.uid('a_member')), 'a member of the organization can be assigned');
select throws_ok(format('update public.tasks set assigned_to = %L where title = ''Linked''', tests.uid('b_owner')), '23503', null, 'a member of another organization cannot');
select throws_ok(format('update public.tasks set assigned_to = %L where title = ''Linked''', tests.uid('outsider')), '23503', null, 'nor a user with no membership');
delete from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_member');
select is((select assigned_to is null and organization_id = tests.org_id('a') from public.tasks where title = 'Linked'), true, 'removing the assignee clears only the assignment');
insert into public.memberships (organization_id, user_id, role) values (tests.org_id('a'), tests.uid('a_member'), 'member');
select throws_ok($$delete from public.customers where id = 'c1000000-0000-4000-8000-0000000000a1'$$, '23503', null, 'a customer that has deals or tasks cannot be deleted');

-- ---- RLS by role
select is(tests.visible_count_as('a_owner', 'public.tasks', format('organization_id = %L', tests.org_id('a'))) > 0, true, 'members read their organization''s tasks');
select is(tests.visible_count_as('a_viewer', 'public.tasks', 'id = ''e1000000-0000-4000-8000-000000000001'''), 1::bigint, 'a viewer can read');
select is(tests.visible_count_as('b_owner', 'public.tasks', format('organization_id = %L', tests.org_id('a'))), 0::bigint, 'another organization''s owner sees none');
select is(tests.visible_count_as('outsider', 'public.tasks'), 0::bigint, 'a user with no membership sees none');
select is(tests.denied_as_anon('select * from public.tasks'), true, 'a visitor cannot read');
select is(tests.rows_changed_as('b_owner', 'update public.tasks set title = ''Hijacked'' where id = ''e1000000-0000-4000-8000-000000000001'''), 0::bigint, 'a cross-tenant update changes nothing');
select is(tests.denied_as('b_owner', format('insert into public.tasks (organization_id, title) values (%L, ''Into A'')', tests.org_id('a'))), true, 'inserting into another organization fails');
select is(tests.denied_as('a_viewer', format('insert into public.tasks (organization_id, title) values (%L, ''Viewer'')', tests.org_id('a'))), true, 'a viewer cannot insert');
select is(tests.rows_changed_as('a_viewer', 'update public.tasks set title = ''Viewer edit'' where id = ''e1000000-0000-4000-8000-000000000001'''), 0::bigint, 'nor update');
select is(tests.denied_as('a_owner', 'delete from public.tasks'), true, 'nobody can delete (archive instead)');
select is(tests.denied_as('a_member', format('insert into public.tasks (organization_id, title, created_by) values (%L, ''Forged'', %L)', tests.org_id('a'), tests.uid('a_owner'))), true, 'created_by cannot be someone else');
select is(tests.sqlstate_of_as('a_member', format('insert into public.tasks (organization_id, title, customer_id) values (%L, ''Cross via API'', ''c1000000-0000-4000-8000-0000000000b1'')', tests.org_id('a'))) <> 'ok', true, 'a writer cannot link another organization''s customer');
select is(tests.sqlstate_of_as('a_owner', format('update public.tasks set organization_id = %L where id = ''e1000000-0000-4000-8000-000000000001''', tests.org_id('b'))) <> 'ok', true, 'organization_id cannot be changed');
select is(tests.sqlstate_of_as('a_owner', format('update public.tasks set created_by = %L where id = ''e1000000-0000-4000-8000-000000000001''', tests.uid('a_owner'))) <> 'ok', true, 'created_by cannot be changed');

-- ---- activity events (same transaction as the change)
select tests.act_as('a_member');
insert into public.tasks (id, organization_id, title, description, due_date) values ('e1000000-0000-4000-8000-000000000010', tests.org_id('a'), 'Order parts', 'secret gate code 4711', '2026-03-09');
select tests.reset();
select is((select summary || '|' || action from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010'), 'Sam Member created task "Order parts"|created', 'creating logs a created event with the actor');
select tests.act_as('a_admin');
update public.tasks set priority = 'urgent', due_date = '2026-03-12', description = 'another secret' where id = 'e1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select changes from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010' and action = 'updated'),
  '{"priority": {"old": "medium", "new": "urgent"}, "due_date": {"old": "2026-03-09", "new": "2026-03-12"}, "_content_changed": ["description"]}'::jsonb, 'editing logs the safe fields with old and new values and only the NAME of the description');
select tests.act_as('a_member');
update public.tasks set status = 'in_progress' where id = 'e1000000-0000-4000-8000-000000000010';
update public.tasks set status = 'done' where id = 'e1000000-0000-4000-8000-000000000010';
update public.tasks set status = 'todo' where id = 'e1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select string_agg(action, ',' order by created_at, id) from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010'), 'created,updated,updated,completed,reopened', 'a status change is an update, finishing is completed, leaving done is reopened (never both an update and a completion)');
select is((select summary from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010' and action = 'completed'), 'Sam Member completed task "Order parts"', 'the completion names the actor and the task');
select is((select changes from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010' and action = 'reopened'), '{"status": {"old": "done", "new": "todo"}}'::jsonb, 'reopening records the status change');
update public.tasks set updated_at = now() where id = 'e1000000-0000-4000-8000-000000000010';
update public.tasks set title = 'Order parts' where id = 'e1000000-0000-4000-8000-000000000010';
select is((select count(*) from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010'), 5::bigint, 'no-op updates write no event');
select tests.act_as('a_owner');
update public.tasks set archived_at = now() where id = 'e1000000-0000-4000-8000-000000000010';
update public.tasks set archived_at = null where id = 'e1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select count(*) from public.activity_events where entity_id = 'e1000000-0000-4000-8000-000000000010' and action in ('archived', 'restored')), 2::bigint, 'archive and restore are each logged');
select is((select count(*) from public.activity_events where changes::text ~* 'secret|4711' or summary ~* 'secret|4711'), 0::bigint, 'no description text reached the activity log');
create temp table before_counts as select (select count(*) from public.tasks) t, (select count(*) from public.activity_events) e;
do $$ begin begin
  insert into public.tasks (organization_id, title) values (tests.org_id('a'), 'Doomed');
  raise exception 'forced';
exception when others then null; end; end $$;
select is((select count(*) from public.tasks) = (select t from before_counts) and (select count(*) from public.activity_events) = (select e from before_counts), true, 'a failure after an insert removes the task and its event');

-- ---- the demo cap (lowered to 3 for the test; default 75), archived rows count, real organizations are free
select is((select value from private.app_limits where key = 'demo_cap_tasks'), 75, 'the default cap is 75');
update private.app_limits set value = 3 where key = 'demo_cap_tasks';
select tests.act_as('g1');
insert into public.tasks (organization_id, title) select tests.org_id('g1'), 'Demo ' || i from generate_series(1, 3) i;
select throws_ok(format('insert into public.tasks (organization_id, title) values (%L, ''Demo 4'')', tests.org_id('g1')), 'OD429', null, 'the next demo task fails with the cap error');
update public.tasks set archived_at = now() where organization_id = tests.org_id('g1');
select throws_ok(format('insert into public.tasks (organization_id, title) values (%L, ''Demo 5'')', tests.org_id('g1')), 'OD429', null, 'archived tasks still count');
select tests.reset();
update private.app_limits set value = 75 where key = 'demo_cap_tasks';
select is(tests.denied_as('g3', format('insert into public.tasks (organization_id, title) values (%L, ''Late'')', tests.org_id('expired'))), true, 'an expired demo cannot insert');

-- ---- the seed: exactly 24 per workspace, spread over the date buckets
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true), ('aa000000-0000-4000-8000-0000000000b2', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot_a as select public.bootstrap_demo_workspace() r;
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000b2', true);
create temp table boot_b as select public.bootstrap_demo_workspace() r;
grant select on boot_a, boot_b to authenticated;
select tests.reset();
create temp table seeded as
  select t.*, (timezone(o.timezone, now()))::date as today
  from public.tasks t join public.organizations o on o.id = t.organization_id
  where t.organization_id = (select (r ->> 'organization_id')::uuid from boot_a);
select is((select count(*) from seeded), 24::bigint, 'the seed adds exactly 24 tasks');
select is((select count(*) from seeded where status <> 'done' and due_date < today), 5::bigint, '5 are overdue');
select is((select count(*) from seeded where status <> 'done' and due_date = today), 3::bigint, '3 are due today');
select is((select count(*) from seeded where status <> 'done' and due_date between today + 1 and today + 7), 5::bigint, '5 are due within the next 7 days');
select is((select count(*) from seeded where status <> 'done' and (due_date > today + 7 or due_date is null)), 6::bigint, '6 are later or undated (the 5th later one and an undated one are in here)');
select is((select count(*) from seeded where status = 'done' and completed_at is not null and completed_at < now()), 5::bigint, '5 are done, with a completion time in the past');
select is((select count(*) from seeded where status = 'blocked'), 2::bigint, '2 are blocked');
select is((select count(*) from seeded where status = 'in_progress'), 4::bigint, '4 are in progress');
select is((select count(*) from seeded where customer_id is not null or opportunity_id is not null), 16::bigint, '16 are linked to a customer or a deal');
select is((select count(*) from seeded s where opportunity_id is not null and not exists (select 1 from public.opportunities o where o.id = s.opportunity_id and o.organization_id = s.organization_id and o.customer_id = s.customer_id)), 0::bigint, 'a task on a deal carries the deal''s customer, in the same workspace');
select is((select md5(string_agg(title || status || priority || (due_date - today)::text, '|' order by title)) from seeded),
  (select md5(string_agg(t.title || t.status || t.priority || (t.due_date - (timezone(o.timezone, now()))::date)::text, '|' order by t.title)) from public.tasks t join public.organizations o on o.id = t.organization_id where t.organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 'two workspaces get identical content');
select is((select count(*) from public.activity_events where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and entity_type = 'task' and actor_user_id is null and summary like 'System created task%'), 24::bigint, 'the seed logged 24 created events as System');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
update public.tasks set title = 'Edited by guest' where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and status = 'todo';
select lives_ok(format('select public.reset_demo_workspace(%L)', (select r ->> 'organization_id' from boot_a)), 'the guest resets their demo');
select tests.reset();
select is((select count(*) from public.tasks where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 24::bigint, 'after a reset there are 24 again (not 48)');
select is((select count(*) from public.tasks where title = 'Edited by guest'), 0::bigint, 'and the edit is gone');
select is((select count(*) from public.tasks where organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 24::bigint, 'the other guest''s workspace is untouched');
select is((public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int >= 1, true, 'the cleanup deletes the expired demo organization (customers, deals and tasks together)');

select * from finish();
rollback;
