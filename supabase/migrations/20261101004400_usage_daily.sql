-- P-03 (SIT-146): first-party, aggregate usage counts for the public demo. Answers "do visitors try the demo, and how far do they
-- get?" with NO cookies, NO browser-side tracking, NO identifiers, NO IP addresses and NO personal data.
--
-- Where the numbers come from: data the app already holds to do its job. A demo workspace's activity history records who changed
-- what (`activity_events.actor_user_id`); the seed is written by the System (actor null), a visitor's own changes carry their guest
-- id. That is how a visitor's customer, stage move, completed task or quote is told apart from the fictional seed.
--
-- Why a rollup table: demo data is deleted 24 hours after it is created. Just before a demo organization is deleted, its few
-- yes/no facts ("created a customer", "moved a deal stage", ...) are added to ONE counter row per UTC day and metric. The counter
-- rows hold counts only: never an id, an e-mail, a name or a time finer than the day.
--
--   * private.usage_daily       (day, metric, total): the rollup. Kept 400 days, then purged by the cleanup.
--   * private.demo_usage        per-demo yes/no flags captured at reset and at rollup. Deleted WITH the demo (cascade).
--   * private.usage_rollup_demo called by the expired-demo cleanup (and by the bootstrap that replaces an expired demo) before
--                               the organization is deleted. Idempotent: a demo is added at most once.
--   * private.usage_capture_demo called by the reset, before it clears the visitor's data, so what they did before a reset still counts.
--   * public.usage_report(days) rolled-up days PLUS the demos still alive (computed live), for `npm run usage:report`.
--
-- The tables live in `private` (not exposed by the API at all), have row level security on and no policy and no grant for any
-- browser role. Every function is EXECUTE for service_role only.

create table private.usage_daily (
  day date not null,
  metric text not null,
  total bigint not null default 0,
  constraint usage_daily_pkey primary key (day, metric),
  constraint usage_daily_metric_values check (metric in (
    'demos_started', 'demos_with_customer_created', 'demos_with_stage_move', 'demos_with_task_completed',
    'demos_with_quote_created', 'demos_reset', 'demos_expired_unused'
  )),
  constraint usage_daily_total_nonneg check (total >= 0)
);
comment on table private.usage_daily is
  'Daily aggregate demo usage counts (UTC day of the demo''s creation). Counts only; written by the cleanup, read by usage_report.';

create table private.demo_usage (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  customer_created boolean not null default false,
  stage_moved boolean not null default false,
  task_completed boolean not null default false,
  quote_created boolean not null default false,
  acted boolean not null default false,
  was_reset boolean not null default false,
  rolled_up boolean not null default false
);
comment on table private.demo_usage is
  'Yes/no facts about one demo, captured before its data is cleared. Booleans only; removed with the organization.';

alter table private.usage_daily enable row level security;
alter table private.demo_usage enable row level security;
revoke all on table private.usage_daily, private.demo_usage from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- The facts about one demo: what is stored (from before a reset) OR what its activity history shows now. A visitor's own change is
-- an event with an actor; the seed is written by the System (no actor), so it never counts.
-- ---------------------------------------------------------------------------------------------
create or replace function private.demo_usage_flags(org_id uuid)
returns table (customer_created boolean, stage_moved boolean, task_completed boolean, quote_created boolean, acted boolean, was_reset boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with live as (
    select
      coalesce(pg_catalog.bool_or(e.entity_type = 'customer' and e.action = 'created'), false) as customer_created,
      coalesce(pg_catalog.bool_or(e.entity_type = 'opportunity' and e.action = 'stage_changed'), false) as stage_moved,
      coalesce(pg_catalog.bool_or(e.entity_type = 'task' and e.action = 'completed'), false) as task_completed,
      coalesce(pg_catalog.bool_or(e.entity_type = 'quote' and e.action = 'created'), false) as quote_created,
      pg_catalog.count(*) > 0 as acted
    from public.activity_events e
    where e.organization_id = org_id and e.actor_user_id is not null
  )
  select
    live.customer_created or coalesce(u.customer_created, false),
    live.stage_moved or coalesce(u.stage_moved, false),
    live.task_completed or coalesce(u.task_completed, false),
    live.quote_created or coalesce(u.quote_created, false),
    live.acted or coalesce(u.acted, false),
    coalesce(u.was_reset, false) or coalesce(w.last_reset_at is not null, false)
  from live
  left join private.demo_usage u on u.organization_id = org_id
  left join public.demo_workspaces w on w.organization_id = org_id
$$;

-- Stores the current facts of a demo (called by the reset BEFORE it clears the visitor's data). Flags only ever turn on.
create or replace function private.usage_capture_demo(org_id uuid, mark_reset boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = org_id and o.kind = 'demo') then
    raise exception using errcode = 'OD403', message = 'Only demo workspaces have usage counts.', detail = 'NOT_A_DEMO';
  end if;
  insert into private.demo_usage as d (organization_id, customer_created, stage_moved, task_completed, quote_created, acted, was_reset)
  select org_id, f.customer_created, f.stage_moved, f.task_completed, f.quote_created, f.acted, f.was_reset or mark_reset
    from private.demo_usage_flags(org_id) f
  on conflict (organization_id) do update set
    customer_created = d.customer_created or excluded.customer_created,
    stage_moved = d.stage_moved or excluded.stage_moved,
    task_completed = d.task_completed or excluded.task_completed,
    quote_created = d.quote_created or excluded.quote_created,
    acted = d.acted or excluded.acted,
    was_reset = d.was_reset or excluded.was_reset;
end;
$$;

-- Adds one demo to the daily counters, at most once (the flag rolled_up is the guard; the organization is deleted in the same
-- transaction by the callers, and a second call after that finds nothing). Returns true when it counted the demo.
-- The day is the UTC day the demo was CREATED on. A reset counts as an action, so a demo that was only reset is not "unused".
create or replace function private.usage_rollup_demo(org_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_kind text;
  org_day date;
  f record;
begin
  -- Lock the organization row: a cleanup and a bootstrap racing for the same expired demo cannot both count it.
  select o.kind, (o.created_at at time zone 'utc')::date into org_kind, org_day
    from public.organizations o where o.id = org_id for update;
  if not found then
    return false;                      -- already deleted (and counted) by someone else
  end if;
  if org_kind <> 'demo' then
    raise exception using errcode = 'OD403', message = 'Only demo workspaces have usage counts.', detail = 'NOT_A_DEMO';
  end if;
  if exists (select 1 from private.demo_usage d where d.organization_id = org_id and d.rolled_up) then
    return false;
  end if;

  perform private.usage_capture_demo(org_id);
  select * into f from private.demo_usage_flags(org_id);

  insert into private.usage_daily as t (day, metric, total)
  select org_day, m.metric, 1
    from (values
      ('demos_started', true),
      ('demos_with_customer_created', f.customer_created),
      ('demos_with_stage_move', f.stage_moved),
      ('demos_with_task_completed', f.task_completed),
      ('demos_with_quote_created', f.quote_created),
      ('demos_reset', f.was_reset),
      ('demos_expired_unused', not f.acted and not f.was_reset)
    ) as m (metric, hit)
   where m.hit
  on conflict (day, metric) do update set total = t.total + 1;

  update private.demo_usage set rolled_up = true where organization_id = org_id;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The report: rolled-up days plus demos still alive (live), plus real accounts. Counts per UTC day only.
--   demos_in_progress  live demos not yet expired (their numbers can still grow; they are never called "unused" yet)
--   real_accounts_created  registered (non-guest) accounts created that day, counted from auth.users when asked (nothing is stored)
-- ---------------------------------------------------------------------------------------------
create or replace function public.usage_report(days integer default 30)
returns table (day date, metric text, total bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  today date := (pg_catalog.now() at time zone 'utc')::date;
begin
  if days is null or days < 1 or days > 400 then
    raise exception 'days must be between 1 and 400';
  end if;
  return query
  with live as (
    select (o.created_at at time zone 'utc')::date as d, (o.expires_at > pg_catalog.now()) as running, f.*
      from public.organizations o
      cross join lateral private.demo_usage_flags(o.id) f
     where o.kind = 'demo'
       and not exists (select 1 from private.demo_usage u where u.organization_id = o.id and u.rolled_up)
  ),
  parts as (
    select r.day as d, r.metric as m, r.total as n from private.usage_daily r
    union all select l.d, 'demos_started', 1 from live l
    union all select l.d, 'demos_in_progress', 1 from live l where l.running
    union all select l.d, 'demos_with_customer_created', 1 from live l where l.customer_created
    union all select l.d, 'demos_with_stage_move', 1 from live l where l.stage_moved
    union all select l.d, 'demos_with_task_completed', 1 from live l where l.task_completed
    union all select l.d, 'demos_with_quote_created', 1 from live l where l.quote_created
    union all select l.d, 'demos_reset', 1 from live l where l.was_reset
    union all select l.d, 'demos_expired_unused', 1 from live l where not l.running and not l.acted and not l.was_reset
    union all
    select (u.created_at at time zone 'utc')::date, 'real_accounts_created', pg_catalog.count(*)
      from auth.users u where not u.is_anonymous group by 1
  )
  select p.d, p.m, pg_catalog.sum(p.n)::bigint
    from parts p
   where p.d > today - days
   group by p.d, p.m
   order by p.d, p.m;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Hook the rollup into the three places a demo organization is deleted or cleared.
-- ---------------------------------------------------------------------------------------------
-- 1. The cleanup (phase 1): count the demo, then clear and delete it. Also purges counter rows older than 400 days.
create or replace function public.cleanup_purge_expired_demos(batch_size integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  org record;
  deleted integer := 0;
  queued integer := 0;
begin
  if batch_size is null or batch_size < 1 or batch_size > 1000 then
    raise exception 'batch_size must be between 1 and 1000';
  end if;
  delete from private.usage_daily where day < (pg_catalog.now() at time zone 'utc')::date - 400;
  for org in
    select o.id from public.organizations o
     where o.kind = 'demo' and o.expires_at < pg_catalog.now()
     order by o.expires_at, o.id
     limit batch_size
     for update skip locked
  loop
    insert into private.demo_cleanup_users (user_id)
    select m.user_id from public.memberships m where m.organization_id = org.id
    on conflict (user_id) do nothing;
    get diagnostics queued = row_count;
    -- Count the demo BEFORE its data goes: same transaction as the delete, so it is counted exactly once.
    perform private.usage_rollup_demo(org.id);
    perform private.clear_demo_data(org.id);
    delete from public.organizations where id = org.id and kind = 'demo' and expires_at < pg_catalog.now();
    deleted := deleted + 1;
  end loop;
  return pg_catalog.jsonb_build_object('orgs_deleted', deleted, 'batch_size', batch_size);
end;
$$;

-- 2. A guest whose own expired demo is replaced by a fresh one (the bootstrap deletes the old organization): count it first.
create or replace function public.bootstrap_demo_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  existing_org uuid;
  existing_expiry timestamptz;
  new_org uuid;
  new_expiry timestamptz;
  active_demos integer;
  ceiling integer := coalesce(private.demo_limit('max_active_demos'), 200);
  guest boolean;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Start the demo from the demo page.', detail = 'NOT_SIGNED_IN';
  end if;

  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if not private.is_anonymous() or guest is distinct from true then
    raise exception using errcode = 'OD403', message = 'The live demo is for guest visitors. Sign out to try it.', detail = 'GUEST_ONLY';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.demo.bootstrap:' || uid::text, 0));

  select w.organization_id, o.expires_at into existing_org, existing_expiry
    from public.demo_workspaces w
    join public.organizations o on o.id = w.organization_id
   where w.user_id = uid;

  if existing_org is not null then
    if existing_expiry > pg_catalog.now() then
      return pg_catalog.jsonb_build_object(
        'organization_id', existing_org,
        'expires_at', existing_expiry,
        'created', false,
        'seed_version', (select w.seed_version from public.demo_workspaces w where w.organization_id = existing_org)
      );
    end if;
    -- The caller's own expired demo: count it, remove it (cascades its mapping and data), then start fresh.
    perform private.usage_rollup_demo(existing_org);
    delete from public.organizations where id = existing_org and kind = 'demo';
  end if;

  select pg_catalog.count(*) into active_demos
    from public.organizations o where o.kind = 'demo' and o.expires_at > pg_catalog.now();
  if active_demos >= ceiling then
    raise exception using
      errcode = 'OD429',
      message = 'The demo is very busy right now. Please try again in a few minutes.',
      detail = 'DEMO_CAPACITY',
      hint = 'retry-after=300';
  end if;

  new_expiry := pg_catalog.now() + private.demo_ttl();
  insert into public.organizations (name, kind, expires_at, created_by)
  values ('Demo Workspace', 'demo', new_expiry, uid)
  returning id into new_org;

  insert into public.memberships (organization_id, user_id, role) values (new_org, uid, 'owner');
  update public.profiles set display_name = 'Demo Owner' where id = uid;

  perform private.register_demo_workspace(new_org, uid);
  perform private.seed_demo_workspace(new_org);

  return pg_catalog.jsonb_build_object(
    'organization_id', new_org,
    'expires_at', new_expiry,
    'created', true,
    'seed_version', private.demo_seed_version()
  );
end;
$$;

-- 3. The reset: capture what the visitor did BEFORE their data is cleared, so it still counts (and mark the demo as reset).
create or replace function public.reset_demo_workspace(org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  guest boolean;
  owned_expiry timestamptz;
  claimed timestamptz;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Start the demo from the demo page.', detail = 'NOT_SIGNED_IN';
  end if;
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if not private.is_anonymous() or guest is distinct from true then
    raise exception using errcode = 'OD403', message = 'Only guest visitors have a demo to reset.', detail = 'GUEST_ONLY';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.demo.reset:' || coalesce(org_id::text, ''), 0));

  select o.expires_at into owned_expiry
    from public.demo_workspaces w
    join public.organizations o on o.id = w.organization_id and o.kind = 'demo'
   where w.organization_id = org_id and w.user_id = uid;
  if not found then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  if owned_expiry is null or owned_expiry <= pg_catalog.now() then
    raise exception using errcode = 'OD403', message = 'This demo has expired. Start a new one to keep exploring.', detail = 'DEMO_EXPIRED';
  end if;

  claimed := private.begin_demo_reset(org_id);      -- OD429 with a retry-after hint when reset less than a minute ago
  perform private.usage_capture_demo(org_id, true); -- count what was done so far; rolls back with a failed reset
  perform private.clear_demo_data(org_id);
  perform private.clear_demo_seed_marker(org_id);
  perform private.seed_demo_workspace(org_id);

  return pg_catalog.jsonb_build_object(
    'organization_id', org_id,
    'reset_at', claimed,
    'expires_at', owned_expiry,
    'seed_version', (select w.seed_version from public.demo_workspaces w where w.organization_id = org_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: service_role only. (CREATE OR REPLACE kept the grants of the three redefined functions; they are restated.)
-- ---------------------------------------------------------------------------------------------
revoke all on function private.demo_usage_flags(uuid), private.usage_capture_demo(uuid, boolean), private.usage_rollup_demo(uuid),
  public.usage_report(integer) from public, anon, authenticated;
grant execute on function private.demo_usage_flags(uuid), private.usage_capture_demo(uuid, boolean), private.usage_rollup_demo(uuid),
  public.usage_report(integer) to service_role;
revoke all on function public.cleanup_purge_expired_demos(integer) from public, anon, authenticated;
grant execute on function public.cleanup_purge_expired_demos(integer) to service_role;
revoke all on function public.bootstrap_demo_workspace() from public, anon;
grant execute on function public.bootstrap_demo_workspace() to authenticated, service_role;
revoke all on function public.reset_demo_workspace(uuid) from public, anon;
grant execute on function public.reset_demo_workspace(uuid) to authenticated, service_role;
