-- SIT-220: tasks, with same-tenant integrity enforced by the database (PRD 6.2, 6.4, US-05).
-- Follows the customers / opportunities pattern: composite keys, normalization, RLS with no delete (archive only),
-- protected columns, demo cap (75), activity logging (plus completed / reopened), and a deterministic demo seed (24 tasks).

create table public.tasks (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  title text not null,
  description text,
  status text not null default 'todo',
  priority text not null default 'medium',
  due_date date,
  assigned_to uuid,
  customer_id uuid,
  opportunity_id uuid,
  completed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint tasks_pkey primary key (id),
  constraint tasks_org_id_key unique (organization_id, id),
  constraint tasks_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint tasks_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  -- A task's customer and opportunity must be in the SAME organization (a null reference is not checked, by MATCH SIMPLE).
  constraint tasks_customer_fkey foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint tasks_opportunity_fkey foreign key (organization_id, opportunity_id) references public.opportunities (organization_id, id),
  constraint tasks_assigned_to_fkey foreign key (organization_id, assigned_to)
    references public.memberships (organization_id, user_id) on delete set null (assigned_to),
  constraint tasks_title_length check (pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 160),
  constraint tasks_description_length check (description is null or pg_catalog.char_length(description) <= 5000),
  constraint tasks_status_values check (status in ('todo', 'in_progress', 'blocked', 'done')),
  constraint tasks_priority_values check (priority in ('low', 'medium', 'high', 'urgent')),
  -- completed_at is set exactly when the task is done (the trigger below sets it; a client cannot)
  constraint tasks_completed_at_matches_status check ((status = 'done') = (completed_at is not null))
);

create index tasks_org_status_due_idx on public.tasks (organization_id, status, due_date);
create index tasks_org_assigned_idx on public.tasks (organization_id, assigned_to);
create index tasks_org_customer_idx on public.tasks (organization_id, customer_id) where customer_id is not null;
create index tasks_org_opportunity_idx on public.tasks (organization_id, opportunity_id) where opportunity_id is not null;
create index tasks_org_archived_updated_idx on public.tasks (organization_id, archived_at, updated_at desc);

comment on table public.tasks is 'Tasks. Soft-deleted through archived_at. Same-organization customer, opportunity and assignee are enforced by composite foreign keys; completed_at is owned by a trigger.';

-- ---------------------------------------------------------------------------------------------
-- Normalization and ownership of completed_at:
--   * done on insert, or a change to done  -> completed_at = now()
--   * staying done                          -> the original completed_at is kept
--   * any other status                      -> completed_at = null
-- Whatever a client sends for completed_at is overwritten. Only the seed runner (system mode) may back-date it.
-- ---------------------------------------------------------------------------------------------
create or replace function private.prepare_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := pg_catalog.btrim(new.title);
  new.description := nullif(pg_catalog.btrim(new.description), '');
  if new.status <> 'done' then
    new.completed_at := null;
  elsif tg_op = 'UPDATE' and old.status = 'done' then
    new.completed_at := old.completed_at;
  elsif not (private.activity_system_mode() and new.completed_at is not null) then
    new.completed_at := pg_catalog.now();
  end if;
  return new;
end;
$$;
revoke all on function private.prepare_task() from public, anon, authenticated;

create trigger tasks_prepare before insert or update on public.tasks
  for each row execute function private.prepare_task();
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();
select private.protect_columns('public.tasks', 'id', 'organization_id', 'created_by', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- Access: exactly the customers pattern.
-- ---------------------------------------------------------------------------------------------
select private.attach_tenant_rls('public.tasks');
drop policy tasks_delete_writer on public.tasks;
revoke delete on table public.tasks from authenticated;
create policy tasks_insert_creator on public.tasks
  as restrictive for insert to authenticated
  with check (created_by is not distinct from auth.uid());

select private.attach_demo_cap('public.tasks', 'demo_cap_tasks');

-- Generic events (created, archived, restored, updated) for everything except the status; the status has its own trigger
-- so that finishing and reopening are named events instead of a generic "updated".
select private.attach_activity_log(
  'public.tasks', 'task', 'title',
  array['title', 'priority', 'due_date', 'assigned_to', 'customer_id', 'opportunity_id'],
  array['description'],
  'archived_at'
);

create or replace function private.log_task_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text := private.activity_actor_name();
  label text := pg_catalog.format('task "%s"', pg_catalog.left(new.title, 80));
begin
  if new.status = old.status then
    return null;
  end if;
  if new.status = 'done' then
    perform private.log_activity(new.organization_id, 'task', new.id, 'completed', pg_catalog.format('%s completed %s', who, label),
      pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('old', old.status, 'new', new.status)));
  elsif old.status = 'done' then
    perform private.log_activity(new.organization_id, 'task', new.id, 'reopened', pg_catalog.format('%s reopened %s', who, label),
      pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('old', old.status, 'new', new.status)));
  else
    perform private.log_activity(new.organization_id, 'task', new.id, 'updated', pg_catalog.format('%s updated %s (status)', who, label),
      pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('old', old.status, 'new', new.status)));
  end if;
  return null;
end;
$$;
revoke all on function private.log_task_status() from public, anon, authenticated;
create trigger tasks_status_activity_log after update on public.tasks
  for each row execute function private.log_task_status();

-- ---------------------------------------------------------------------------------------------
-- Demo seed: exactly 24 tasks per workspace, dated relative to TODAY in the organization's time zone:
--   5 overdue, 3 due today, 5 due within the next 7 days, 5 later (one with no date), 5 done, and 2 of the open ones blocked.
-- Linked to the seeded customers and opportunities (a task on a deal also carries the deal's customer).
-- ---------------------------------------------------------------------------------------------
create or replace function private.seed_tasks(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  tz text;
  today date;
  customer_ids uuid[];
  opp_ids uuid[];
  opp_customers uuid[];
  titles text[] := array[
    'Send revised quote', 'Call about site access', 'Confirm delivery window', 'Chase signed approval', 'Order replacement parts',
    'Schedule on-site walkthrough', 'Review contract terms', 'Prepare invoice', 'Follow up after estimate', 'Book crew for next week',
    'Collect measurements', 'Update project notes', 'Check permit status', 'Plan seasonal check-in', 'Request references',
    'Draft maintenance proposal', 'Renewal reminder', 'Review supplier pricing', 'Tidy customer records',
    'Send thank-you note', 'Close out finished job', 'Collect final payment', 'Archive signed paperwork', 'Post-job survey'
  ];
  statuses text[] := array[
    'todo', 'in_progress', 'todo', 'blocked', 'todo',
    'todo', 'in_progress', 'todo',
    'todo', 'in_progress', 'todo', 'blocked', 'todo',
    'todo', 'todo', 'in_progress', 'todo', 'todo', 'todo',
    'done', 'done', 'done', 'done', 'done'
  ];
  priorities text[] := array[
    'high', 'urgent', 'medium', 'high', 'low',
    'high', 'medium', 'urgent',
    'medium', 'high', 'low', 'medium', 'medium',
    'low', 'medium', 'low', 'high', 'low', 'low',
    'medium', 'low', 'high', 'low', 'low'
  ];
  -- days from today (null = no due date)
  offsets integer[] := array[
    -12, -9, -5, -3, -1,
    0, 0, 0,
    1, 2, 3, 5, 7,
    10, 14, 21, 30, 45, null,
    -20, -14, -8, -4, -2
  ];
  i integer;
  link integer;
begin
  select m.user_id into owner_id from public.memberships m where m.organization_id = org_id and m.role = 'owner' order by m.user_id limit 1;
  select o.timezone into tz from public.organizations o where o.id = org_id;
  today := (pg_catalog.timezone(tz, pg_catalog.now()))::date;
  select array_agg(c.id order by c.display_name) into customer_ids
    from (select id, display_name from public.customers where organization_id = org_id and archived_at is null order by display_name limit 10) c;
  select array_agg(o.id order by o.title), array_agg(o.customer_id order by o.title) into opp_ids, opp_customers
    from public.opportunities o where o.organization_id = org_id and o.archived_at is null;
  for i in 1..24 loop
    link := i % 3; -- 0: a deal (and its customer), 1: a customer, 2: nothing
    insert into public.tasks (
      organization_id, title, description, status, priority, due_date, assigned_to, customer_id, opportunity_id,
      completed_at, created_by, created_at, updated_at
    ) values (
      org_id, titles[i],
      case when i % 4 = 1 then 'Keep the customer posted once this is done.' else null end,
      statuses[i], priorities[i],
      case when offsets[i] is null then null else today + offsets[i] end,
      case when i % 2 = 0 then owner_id else null end,
      case link when 0 then opp_customers[(i / 3 - 1) % pg_catalog.cardinality(opp_customers) + 1] when 1 then customer_ids[(i - 1) % 10 + 1] else null end,
      case link when 0 then opp_ids[(i / 3 - 1) % pg_catalog.cardinality(opp_ids) + 1] else null end,
      case when statuses[i] = 'done' then private.demo_ts(26 - i, 14) else null end,
      null,
      private.demo_ts(60 - i, 9),
      private.demo_ts(greatest(1, 30 - i), 11)
    );
  end loop;
end;
$$;
create or replace function private.clear_tasks(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.tasks where organization_id = org_id;
end;
$$;
revoke all on function private.seed_tasks(uuid), private.clear_tasks(uuid) from public, anon, authenticated;
-- Position 30: after the customers and deals they reference (cleared first on reset, seeded last).
select private.register_demo_seeder('tasks', 30, 'private.seed_tasks(uuid)'::regprocedure, 1, 'private.clear_tasks(uuid)'::regprocedure);
