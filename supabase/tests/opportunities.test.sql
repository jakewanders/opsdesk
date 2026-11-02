-- pgTAP tests for public.opportunities (SIT-216, PRD 6.2, 6.4, US-04).
begin;
select plan(89);
select tests.create_fixtures();
update public.profiles set display_name = 'Sam Member' where id = tests.uid('a_member');

insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer'),
  ('c1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'Globex Customer');

-- ---- shape
select has_table('public', 'opportunities', 'the table exists');
select is((select relrowsecurity from pg_class where oid = 'public.opportunities'::regclass), true, 'row level security is on');
select is((select count(*) from pg_constraint where conrelid = 'public.opportunities'::regclass and conname = 'opportunities_org_id_key' and contype = 'u'), 1::bigint, 'unique (organization_id, id) exists');
select is((select array_agg(indexname::text order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'opportunities'),
  array['opportunities_org_archived_updated_idx', 'opportunities_org_close_date_idx', 'opportunities_org_customer_idx', 'opportunities_org_id_key', 'opportunities_org_stage_archived_idx', 'opportunities_pkey'], 'the stage, customer, close-date and list indexes exist');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'opportunities' and grantee = 'authenticated'), 'INSERT,SELECT,UPDATE', 'authenticated may select, insert and update, never delete');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'opportunities' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds nothing');

-- ---- inserts: defaults and probability
select lives_ok($$insert into public.opportunities (id, organization_id, customer_id, title) values ('d1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', '  Warehouse Retrofit ')$$, 'a minimal insert works');
select is((select title || '|' || stage || '|' || amount_cents || '|' || probability_percent from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 'Warehouse Retrofit|new|0|10', 'trimmed title, stage new, amount 0, probability from the stage (10)');
insert into public.opportunities (organization_id, customer_id, title, stage, closed_at, lost_reason)
  select tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'P ' || s, s, case when s in ('won', 'lost') then now() end, case when s = 'lost' then 'no budget' end
  from unnest(array['qualified', 'proposal', 'negotiation', 'won', 'lost']) s;
select is((select string_agg(stage || ':' || probability_percent, ',' order by stage) from public.opportunities where title like 'P %'), 'lost:0,negotiation:75,proposal:50,qualified:25,won:100', 'the default probability follows the stage on insert (25/50/75/100/0)');
insert into public.opportunities (organization_id, customer_id, title, stage, probability_percent) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Explicit', 'qualified', 40);
select is((select probability_percent from public.opportunities where title = 'Explicit'), 40::smallint, 'an explicit probability wins');

-- ---- updates: stage change resets the default unless the probability was changed explicitly
update public.opportunities set stage = 'proposal' where id = 'd1000000-0000-4000-8000-000000000001';
select is((select probability_percent from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 50::smallint, 'changing the stage resets the probability to the new stage''s default');
update public.opportunities set stage = 'negotiation', probability_percent = 60 where id = 'd1000000-0000-4000-8000-000000000001';
select is((select probability_percent from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 60::smallint, 'a probability changed together with the stage is kept');
update public.opportunities set title = 'Warehouse Retrofit Phase 2' where id = 'd1000000-0000-4000-8000-000000000001';
select is((select probability_percent from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 60::smallint, 'an update that does not change the stage leaves the probability alone');

-- ---- constraints
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'x')$$, '23514', null, 'a one-character title is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', repeat('t', 151))$$, '23514', null, 'a title over 150 is refused');
select lives_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', repeat('t', 150))$$, 'exactly 150 is fine');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, description) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Ok title', repeat('d', 5001))$$, '23514', null, 'a description over 5,000 is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Ok title', 'archived')$$, '23514', null, 'an unknown stage is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, amount_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Ok title', -1)$$, '23514', null, 'a negative amount is refused');
select lives_ok($$insert into public.opportunities (organization_id, customer_id, title, amount_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Max amount', 100000000000)$$, 'the maximum amount is accepted');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, amount_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Too much', 100000000001)$$, '23514', null, 'one cent over is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, probability_percent) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Ok title', 101)$$, '23514', null, 'a probability over 100 is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, probability_percent) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Ok title', -1)$$, '23514', null, 'a negative probability is refused');
-- lost needs a reason; only lost has one; closed_at matches the stage
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Lost no reason', 'lost', now())$$, '23514', null, 'lost without a reason is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at, lost_reason) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Lost blank', 'lost', now(), '   ')$$, '23514', null, 'a blank reason does not count');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at, lost_reason) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Lost long', 'lost', now(), repeat('r', 501))$$, '23514', null, 'a reason over 500 is refused');
select lives_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at, lost_reason) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Lost ok', 'lost', now(), repeat('r', 500))$$, 'a 500-character reason is accepted');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, lost_reason) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Open with reason', 'qualified', 'because')$$, '23514', null, 'an open deal cannot carry a lost reason');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Won not closed', 'won')$$, '23514', null, 'won without closed_at is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Open but closed', 'proposal', now())$$, '23514', null, 'closed_at on an open stage is refused ("closed without stage")');
select lives_ok($$insert into public.opportunities (organization_id, customer_id, title, stage, closed_at) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Won ok', 'won', now())$$, 'won with closed_at is fine');
select throws_ok($$update public.opportunities set stage = 'lost' where id = 'd1000000-0000-4000-8000-000000000001'$$, '23514', null, 'moving to lost by a plain update without reason and closed_at is refused');
select lives_ok($$update public.opportunities set stage = 'lost', lost_reason = 'Chose a competitor', closed_at = now() where id = 'd1000000-0000-4000-8000-000000000001'$$, 'moving to lost with reason and closed_at works');
select lives_ok($$update public.opportunities set stage = 'qualified', lost_reason = null, closed_at = null where id = 'd1000000-0000-4000-8000-000000000001'$$, 'reopening clears both');
select is((select probability_percent from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), 25::smallint, 'and the probability follows the reopened stage');

-- ---- composite foreign keys: same tenant only
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000b1', 'Cross-tenant customer')$$, '23503', null, 'a customer of another organization is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), gen_random_uuid(), 'Unknown customer')$$, '23503', null, 'an unknown customer is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('b'), 'c1000000-0000-4000-8000-0000000000a1', 'Other org, A customer')$$, '23503', null, 'and so is the reverse');
select throws_ok($$update public.opportunities set customer_id = 'c1000000-0000-4000-8000-0000000000b1' where id = 'd1000000-0000-4000-8000-000000000001'$$, '23503', null, 'moving a deal to another organization''s customer is refused');
select throws_ok($$insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), null, 'No customer')$$, '23502', null, 'a customer is required');
select lives_ok(format('update public.opportunities set assigned_to = %L where id = ''d1000000-0000-4000-8000-000000000001''', tests.uid('a_member')), 'a member of the organization can be assigned');
select throws_ok(format('update public.opportunities set assigned_to = %L where id = ''d1000000-0000-4000-8000-000000000001''', tests.uid('b_owner')), '23503', null, 'a member of another organization cannot');
select throws_ok(format('update public.opportunities set assigned_to = %L where id = ''d1000000-0000-4000-8000-000000000001''', tests.uid('outsider')), '23503', null, 'nor a user with no membership');
delete from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_member');
select is((select assigned_to is null and organization_id = tests.org_id('a') from public.opportunities where id = 'd1000000-0000-4000-8000-000000000001'), true, 'removing the assignee clears only the assignment');
insert into public.memberships (organization_id, user_id, role) values (tests.org_id('a'), tests.uid('a_member'), 'member');

-- a customer with deals cannot be deleted; archiving it keeps the deals
select throws_ok($$delete from public.customers where id = 'c1000000-0000-4000-8000-0000000000a1'$$, '23503', null, 'a customer that has deals cannot be deleted');
update public.customers set archived_at = now() where id = 'c1000000-0000-4000-8000-0000000000a1';
select is((select count(*) from public.opportunities where customer_id = 'c1000000-0000-4000-8000-0000000000a1') > 0, true, 'archiving a customer keeps its historical deals (no cascade)');
update public.customers set archived_at = null where id = 'c1000000-0000-4000-8000-0000000000a1';

-- ---- RLS by role
select is(tests.visible_count_as('a_owner', 'public.opportunities', format('organization_id = %L', tests.org_id('a'))) > 0, true, 'members read their organization''s deals');
select is(tests.visible_count_as('a_viewer', 'public.opportunities', 'id = ''d1000000-0000-4000-8000-000000000001'''), 1::bigint, 'a viewer can read');
select is(tests.visible_count_as('b_owner', 'public.opportunities', format('organization_id = %L', tests.org_id('a'))), 0::bigint, 'another organization''s owner sees none');
select is(tests.visible_count_as('outsider', 'public.opportunities'), 0::bigint, 'a user with no membership sees none');
select is(tests.denied_as_anon('select * from public.opportunities'), true, 'a visitor cannot read');
select is(tests.rows_changed_as('b_owner', 'update public.opportunities set title = ''Hijacked'' where id = ''d1000000-0000-4000-8000-000000000001'''), 0::bigint, 'a cross-tenant update changes nothing');
select is(tests.denied_as('b_owner', 'delete from public.opportunities'), true, 'a cross-tenant delete fails');
select is(tests.denied_as('b_owner', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000a1'', ''Into A'')', tests.org_id('a'))), true, 'inserting into another organization fails');
select is(tests.denied_as('a_viewer', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000a1'', ''Viewer'')', tests.org_id('a'))), true, 'a viewer cannot insert');
select is(tests.rows_changed_as('a_viewer', 'update public.opportunities set title = ''Viewer edit'' where id = ''d1000000-0000-4000-8000-000000000001'''), 0::bigint, 'nor update');
select is(tests.denied_as('a_owner', 'delete from public.opportunities'), true, 'nobody can delete (archive instead)');
select is(tests.denied_as('a_member', format('insert into public.opportunities (organization_id, customer_id, title, created_by) values (%L, ''c1000000-0000-4000-8000-0000000000a1'', ''Forged'', %L)', tests.org_id('a'), tests.uid('a_owner'))), true, 'created_by cannot be someone else');
select is(tests.sqlstate_of_as('a_member', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000b1'', ''Cross customer via API'')', tests.org_id('a'))) <> 'ok', true, 'a writer cannot point a deal at another organization''s customer either');

-- ---- immutable columns
select is(tests.sqlstate_of_as('a_owner', format('update public.opportunities set organization_id = %L where id = ''d1000000-0000-4000-8000-000000000001''', tests.org_id('b'))) <> 'ok', true, 'organization_id cannot be changed');
select is(tests.sqlstate_of_as('a_owner', format('update public.opportunities set created_by = %L where id = ''d1000000-0000-4000-8000-000000000001''', tests.uid('a_owner'))) <> 'ok', true, 'created_by cannot be changed');
select is(tests.sqlstate_of_as('a_owner', 'update public.opportunities set created_at = now() - interval ''1 year'' where id = ''d1000000-0000-4000-8000-000000000001''') <> 'ok', true, 'created_at cannot be changed');

-- ---- activity events (same transaction as the change)
select tests.act_as('a_member');
insert into public.opportunities (id, organization_id, customer_id, title, amount_cents, description) values ('d1000000-0000-4000-8000-000000000010', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Boiler Replacement', 480000, 'secret site access code 4711');
select tests.reset();
select is((select summary || '|' || action from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000010'), 'Sam Member created opportunity "Boiler Replacement"|created', 'creating logs a created event with the actor');
select tests.act_as('a_admin');
update public.opportunities set stage = 'qualified', amount_cents = 520000, description = 'another secret' where id = 'd1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select changes from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000010' and action = 'updated'),
  '{"amount_cents": {"old": 480000, "new": 520000}, "_content_changed": ["description"]}'::jsonb, 'editing logs the safe fields with old and new values and only the NAME of the description');
select is((select changes from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000010' and action = 'stage_changed'),
  '{"stage": {"old": "new", "new": "qualified"}, "probability_percent": {"old": 10, "new": 25}}'::jsonb, 'and the stage change is its own stage_changed event with the probability reset');
select tests.act_as('a_owner');
update public.opportunities set archived_at = now() where id = 'd1000000-0000-4000-8000-000000000010';
update public.opportunities set archived_at = null where id = 'd1000000-0000-4000-8000-000000000010';
select tests.reset();
select is((select string_agg(action, ',' order by created_at, id) from public.activity_events where entity_id = 'd1000000-0000-4000-8000-000000000010'), 'created,updated,stage_changed,archived,restored', 'created, updated, stage_changed, archived and restored are each logged');
select is((select count(*) from public.activity_events where changes::text ~* 'secret|4711' or summary ~* 'secret|4711'), 0::bigint, 'no description text reached the activity log');
create temp table before_counts as select (select count(*) from public.opportunities) o, (select count(*) from public.activity_events) e;
do $$ begin begin
  insert into public.opportunities (organization_id, customer_id, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Doomed');
  raise exception 'forced';
exception when others then null; end; end $$;
select is((select count(*) from public.opportunities) = (select o from before_counts) and (select count(*) from public.activity_events) = (select e from before_counts), true, 'a failure after an insert removes the deal and its event');

-- ---- the demo cap (lowered to 3 for the test; default 30), archived rows count, real organizations are free
select is((select value from private.app_limits where key = 'demo_cap_opportunities'), 30, 'the default cap is 30');
insert into public.customers (id, organization_id, display_name) values ('c1000000-0000-4000-8000-0000000000d1', tests.org_id('g1'), 'Demo Customer');
update private.app_limits set value = 3 where key = 'demo_cap_opportunities';
select tests.act_as('g1');
insert into public.opportunities (organization_id, customer_id, title) select tests.org_id('g1'), 'c1000000-0000-4000-8000-0000000000d1', 'Demo ' || i from generate_series(1, 3) i;
select throws_ok(format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000d1'', ''Demo 4'')', tests.org_id('g1')), 'OD429', null, 'the next demo opportunity fails with the cap error');
update public.opportunities set archived_at = now() where organization_id = tests.org_id('g1');
select throws_ok(format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000d1'', ''Demo 5'')', tests.org_id('g1')), 'OD429', null, 'archived deals still count');
select tests.reset();
update private.app_limits set value = 30 where key = 'demo_cap_opportunities';
select is(tests.denied_as('g3', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, ''c1000000-0000-4000-8000-0000000000d1'', ''Late'')', tests.org_id('expired'))), true, 'an expired demo cannot insert');

-- ---- the seed: exactly 10 per workspace, coherent with the seeded customers
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true), ('aa000000-0000-4000-8000-0000000000b2', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot_a as select public.bootstrap_demo_workspace() r;
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000b2', true);
create temp table boot_b as select public.bootstrap_demo_workspace() r;
grant select on boot_a, boot_b to authenticated;
select tests.reset();
select is((select count(*) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 10::bigint, 'the seed adds exactly 10 opportunities');
select is((select string_agg(stage || ':' || n, ',' order by stage) from (select stage, count(*) n from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) group by stage) s), 'lost:1,negotiation:1,new:2,proposal:2,qualified:2,won:2', 'spread across the stages: 2 new, 2 qualified, 2 proposal, 1 negotiation, 2 won, 1 lost');
select is((select count(*) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and ((stage in ('won', 'lost')) <> (closed_at is not null))), 0::bigint, 'closed_at matches the stage on every seeded row');
select is((select lost_reason is not null from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and stage = 'lost'), true, 'the lost deal has a reason');
select is((select count(*) from public.opportunities o join public.customers c on c.id = o.customer_id and c.organization_id = o.organization_id where o.organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 10::bigint, 'every seeded deal belongs to a seeded customer of the same workspace');
select is((select count(distinct customer_id) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 10::bigint, 'one deal per customer for ten different customers');
select is((select count(*) from public.opportunities o join public.customers c on c.id = o.customer_id where o.organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and c.archived_at is not null), 0::bigint, 'none on an archived customer');
select is((select count(*) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and amount_cents between 100000 and 10000000), 10::bigint, 'amounts are plausible (1,000.00 to 100,000.00)');
select is((select md5(string_agg(title || stage || amount_cents || probability_percent, '|' order by title)) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)),
  (select md5(string_agg(title || stage || amount_cents || probability_percent, '|' order by title)) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 'two workspaces get identical content');
select is((select count(*) from public.activity_events where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and entity_type = 'opportunity' and actor_user_id is null and summary like 'System created opportunity%'), 10::bigint, 'the seed logged 10 created events as System');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
select lives_ok($$select public.bootstrap_demo_workspace()$$, 'bootstrapping again');
update public.opportunities set title = 'Edited by guest' where organization_id = (select (r ->> 'organization_id')::uuid from boot_a) and stage = 'new';
select lives_ok(format('select public.reset_demo_workspace(%L)', (select r ->> 'organization_id' from boot_a)), 'the guest resets their demo');
select tests.reset();
select is((select count(*) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 10::bigint, 'after a reset there are 10 again (not 20)');
select is((select count(*) from public.opportunities where title = 'Edited by guest'), 0::bigint, 'and the edit is gone');
select is((select count(*) from public.customers where organization_id = (select (r ->> 'organization_id')::uuid from boot_a)), 18::bigint, 'with 18 customers');
select is((select count(*) from public.opportunities where organization_id = (select (r ->> 'organization_id')::uuid from boot_b)), 10::bigint, 'the other guest''s workspace is untouched');
select is((public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int >= 1, true, 'the cleanup deletes the expired demo organization (customers and deals together)');

select * from finish();
rollback;
