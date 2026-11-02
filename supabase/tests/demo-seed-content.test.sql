-- pgTAP tests for the CONTENT of a freshly bootstrapped demo workspace (SIT-258): exact counts, coherent relationships,
-- a 90-day activity history consistent with the entities, determinism across guests and across a reset, and a lint over
-- every seeded string for anything that could be a real person, number or inbox.
begin;
select plan(44);

insert into auth.users (id, email, is_anonymous) values
  ('91000000-0000-0000-0000-000000000001', null, true),
  ('92000000-0000-0000-0000-000000000002', null, true);

select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
create temp table g1 on commit drop as select (public.bootstrap_demo_workspace() ->> 'organization_id')::uuid as org;
reset role;
select tests.act_as_role('authenticated', '92000000-0000-0000-0000-000000000002', true);
create temp table g2 on commit drop as select (public.bootstrap_demo_workspace() ->> 'organization_id')::uuid as org;
reset role;
grant select on g1, g2 to public;

-- ---- exact counts
select is((select count(*) from public.customers where organization_id = (select org from g1)), 18::bigint, '18 customers');
select is((select count(*) from public.opportunities where organization_id = (select org from g1)), 10::bigint, '10 opportunities');
select is((select count(*) from public.tasks where organization_id = (select org from g1)), 24::bigint, '24 tasks');
select is((select count(*) from public.activity_events where organization_id = (select org from g1)), 44::bigint, '44 activity events (about 40)');
select is((select count(*) from public.customers where organization_id = (select org from g1) and archived_at is not null), 3::bigint, 'a few archived customers (3)');

-- ---- relationships
select is((select count(*) from public.opportunities o where o.organization_id = (select org from g1) and not exists (select 1 from public.customers c where c.id = o.customer_id and c.organization_id = o.organization_id)), 0::bigint, 'every opportunity has a customer of the same workspace');
select is((select count(*) from public.tasks t where t.organization_id = (select org from g1) and t.customer_id is not null and not exists (select 1 from public.customers c where c.id = t.customer_id and c.organization_id = t.organization_id)), 0::bigint, 'every task customer is in the same workspace');
select is((select count(*) from public.tasks t where t.organization_id = (select org from g1) and t.opportunity_id is not null and not exists (select 1 from public.opportunities o where o.id = t.opportunity_id and o.organization_id = t.organization_id)), 0::bigint, 'every task opportunity is in the same workspace');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and customer_id is not null), '>=', 12::bigint, 'most tasks are linked to a customer');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and opportunity_id is not null), '>=', 5::bigint, 'several tasks are linked to an opportunity');
select is((select count(distinct stage) from public.opportunities where organization_id = (select org from g1)), 6::bigint, 'every stage is represented (new to lost)');
select is((select count(*) from public.opportunities where organization_id = (select org from g1) and stage = 'won' and closed_at is not null), 2::bigint, 'two won deals with a close time');
select is((select count(*) from public.opportunities where organization_id = (select org from g1) and stage = 'lost' and closed_at is not null and length(btrim(lost_reason)) > 0), 1::bigint, 'a lost deal with a reason');
select is((select count(*) from public.opportunities where organization_id = (select org from g1) and stage in ('new','qualified','proposal','negotiation') and (closed_at is not null or lost_reason is not null)), 0::bigint, 'open deals carry no close time or lost reason');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and status <> 'done' and due_date < current_date), '>=', 3::bigint, 'overdue tasks exist');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and status <> 'done' and due_date = current_date), '>=', 1::bigint, 'tasks due today exist');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and status <> 'done' and due_date > current_date), '>=', 5::bigint, 'upcoming tasks exist');
select cmp_ok((select count(*) from public.tasks where organization_id = (select org from g1) and status = 'done'), '>=', 3::bigint, 'completed tasks exist');
select is((select count(*) from public.tasks where organization_id = (select org from g1) and ((status = 'done') <> (completed_at is not null))), 0::bigint, 'completed_at is set exactly for done tasks');

-- ---- the numbers a first dashboard view needs are all meaningful
select cmp_ok((select coalesce(sum(amount_cents), 0) from public.opportunities where organization_id = (select org from g1) and stage in ('new','qualified','proposal','negotiation')), '>', 0::numeric, 'open pipeline is greater than zero');
select cmp_ok((select count(*) from public.opportunities where organization_id = (select org from g1) and stage = 'won' and closed_at > now() - interval '30 days'), '>=', 1::bigint, 'there is a deal won in the last 30 days');
select cmp_ok((select count(*) from public.customers where organization_id = (select org from g1) and archived_at is null and status = 'lead'), '>=', 1::bigint, 'there are leads');

-- ---- activity history: spread, consistency, actor
select cmp_ok((select min(created_at) from public.activity_events where organization_id = (select org from g1)), '>=', now() - interval '90 days', 'no event is older than 90 days');
select cmp_ok((select max(created_at) from public.activity_events where organization_id = (select org from g1)), '<=', now(), 'no event is in the future');
select cmp_ok((select count(distinct created_at::date) from public.activity_events where organization_id = (select org from g1)), '>=', 25::bigint, 'events fall on at least 25 different days');
select is((select count(*) from (select width_bucket(extract(epoch from (now() - created_at)) / 86400, 0, 90, 3) b from public.activity_events where organization_id = (select org from g1) group by 1) s), 3::bigint, 'events exist in each of the three 30-day periods');
select is((select count(*) from public.activity_events where organization_id = (select org from g1) and actor_user_id is not null), 0::bigint, 'every seeded event is by the System');
select is((select count(*) from public.activity_events where organization_id = (select org from g1) and summary !~ '^System '), 0::bigint, 'every summary names the System');
select is((select count(*) from public.activity_events e where e.organization_id = (select org from g1) and not exists (select 1 from public.customers c where c.id = e.entity_id union all select 1 from public.opportunities o where o.id = e.entity_id union all select 1 from public.tasks t where t.id = e.entity_id)), 0::bigint, 'every event points at an existing record');
select is((select count(*) from public.activity_events e join public.customers c on c.id = e.entity_id where e.organization_id = (select org from g1) and e.created_at < c.created_at), 0::bigint, 'no customer event is older than the customer');
select is((select count(*) from public.activity_events e join public.opportunities o on o.id = e.entity_id where e.organization_id = (select org from g1) and e.created_at < o.created_at), 0::bigint, 'no opportunity event is older than the opportunity');
select is((select count(*) from public.opportunities o where o.organization_id = (select org from g1) and o.stage in ('won','lost') and not exists (select 1 from public.activity_events e where e.entity_id = o.id and e.action = 'stage_changed' and e.created_at between o.created_at and o.closed_at)), 0::bigint, 'each won or lost deal has a stage_changed event after it was created and not after it closed');
select is((select count(*) from public.opportunities o where o.organization_id = (select org from g1) and o.stage <> 'new' and not exists (select 1 from public.activity_events e where e.entity_id = o.id and e.action = 'stage_changed' and e.changes -> 'stage' ->> 'new' = o.stage)), 0::bigint, 'every deal past New has a stage_changed event into its current stage');
select is((select count(*) from public.tasks t where t.organization_id = (select org from g1) and t.status = 'done' and not exists (select 1 from public.activity_events e where e.entity_id = t.id and e.action = 'completed' and e.created_at = t.completed_at)), 0::bigint, 'each done task has a completed event at its completion time');
select is((select count(*) from public.customers c where c.organization_id = (select org from g1) and c.archived_at is not null and not exists (select 1 from public.activity_events e where e.entity_id = c.id and e.action = 'archived' and e.created_at = c.archived_at)), 0::bigint, 'each archived customer has an archived event at that time');

select is((select count(*) from public.activity_events e where e.organization_id = (select org from g1) and e.action = 'stage_changed' and (e.summary !~ '^System moved "[^"]+" from [A-Z][a-z]+ to [A-Z][a-z]+$' or jsonb_typeof(e.changes -> 'probability_percent') <> 'object' or not (e.changes -> 'probability_percent' ?& array['old', 'new']))), 0::bigint, 'seeded stage events read and are shaped exactly like live ones (SIT-257)');

-- ---- determinism: a second guest gets identical content, and a reset reproduces the first guest's exactly
create function pg_temp.fingerprint(o uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(concat_ws('~', display_name, company_name, email, phone, website, status, source, array_to_string(tags, ','), notes, created_at, archived_at), ';' order by created_at, display_name) from public.customers where organization_id = o),
    (select string_agg(concat_ws('~', title, stage, amount_cents, probability_percent, expected_close_date, lost_reason, created_at, closed_at), ';' order by created_at, title) from public.opportunities where organization_id = o),
    (select string_agg(concat_ws('~', title, status, priority, due_date, completed_at, created_at), ';' order by created_at, title) from public.tasks where organization_id = o),
    (select string_agg(concat_ws('~', entity_type, action, summary, created_at, changes), ';' order by created_at, summary) from public.activity_events where organization_id = o)))
$$;
create temp table fp_before on commit drop as select pg_temp.fingerprint((select org from g1)) as fp;
select is(pg_temp.fingerprint((select org from g2)), (select fp from fp_before), 'two guests get identical content (names, amounts, dates, events)');
select tests.act_as_role('authenticated', '91000000-0000-0000-0000-000000000001', true);
select lives_ok(format($$select public.reset_demo_workspace(%L)$$, (select org from g1)), 'the guest can reset their demo');
reset role;
select is(pg_temp.fingerprint((select org from g1)), (select fp from fp_before), 'after a reset the content is identical to the first seed');
select is((select count(*) from public.activity_events where organization_id = (select org from g1)), 44::bigint, 'and the reset history is still 44 events');

-- ---- fixture lint over every seeded string
select is((select count(*) from public.customers where organization_id = (select org from g1) and email !~ '^[a-z]+\.[a-z]+@example\.com$'), 0::bigint, 'every customer email is first.last@example.com');
select is((select count(*) from public.customers where organization_id = (select org from g1) and phone !~ '^\(202\) 555-01[0-9]{2}$'), 0::bigint, 'every customer phone is in the reserved 555-01xx range');
select is((select count(*) from public.customers where organization_id = (select org from g1) and website is not null and website !~ '^https://www\.example\.com/[a-z0-9-]+$'), 0::bigint, 'every website is on example.com');
select is((select count(*) from (
  select concat_ws(' ', display_name, company_name, notes, array_to_string(tags, ' ')) s from public.customers where organization_id = (select org from g1)
  union all select concat_ws(' ', title, description, lost_reason) from public.opportunities where organization_id = (select org from g1)
  union all select concat_ws(' ', title, description) from public.tasks where organization_id = (select org from g1)
  union all select summary from public.activity_events where organization_id = (select org from g1)
) all_text where s ~* '(@|https?://|www\.|\d{3}[-. )]\d{3}[-. ]\d{4}|\d{3}-\d{2}-\d{4}|gmail|yahoo|outlook|hotmail|icloud|\.com\M)'), 0::bigint, 'no free text contains an address, link, phone number, SSN-like number or real mail provider');

select * from finish();
rollback;
