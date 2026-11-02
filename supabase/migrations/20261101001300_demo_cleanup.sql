-- SIT-207: database side of the two-phase expired-demo cleanup (PRD 8.2).
--
-- Phase 1 (here, in SQL): delete expired DEMO organizations in bounded batches. Each organization's registered clear
-- functions run first (so append-only tables use their privileged path, scoped per organization), then the
-- organization row goes (its memberships and demo mapping cascade). The anonymous owner is queued for phase 2.
-- Phase 2 (TypeScript, Admin API): delete each queued user through the Auth Admin API, but only if the predicate
-- below says it is safe. A failure leaves the user queued for the next run.
--
-- All functions are EXECUTE for service_role only. They are in `public` solely so the server's secret-key client
-- can call them over PostgREST; no browser role can.

create table private.demo_cleanup_users (
  user_id uuid primary key,
  queued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text
);
revoke all on table private.demo_cleanup_users from public, anon, authenticated;

-- SAFETY PREDICATE. True only for an anonymous user who has no membership left anywhere (an active demo still has
-- one, so its guest is never touched) and who created no real organization. Unknown user, null, anything uncertain:
-- false (fail closed).
create or replace function private.cleanup_user_eligible(uid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  guest boolean;
begin
  if uid is null then
    return false;
  end if;
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if guest is distinct from true then
    return false;                      -- not found, or a registered user: never deleted by cleanup
  end if;
  if exists (select 1 from public.memberships m where m.user_id = uid) then
    return false;                      -- still belongs to an organization (an active demo, or anything real)
  end if;
  if exists (select 1 from public.organizations o where o.created_by = uid and o.kind <> 'demo') then
    return false;                      -- created a real organization
  end if;
  return true;
end;
$$;

-- Queues anonymous users that belong to nothing and are old enough to be stale (a bootstrap that never finished, an
-- organization removed by an earlier run). The age floor keeps a guest who just signed in and has not bootstrapped yet safe.
create or replace function private.enqueue_orphan_guests(min_age interval)
returns integer
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    insert into private.demo_cleanup_users (user_id)
    select u.id from auth.users u
     where u.is_anonymous = true
       and u.created_at < pg_catalog.now() - min_age
       and not exists (select 1 from public.memberships m where m.user_id = u.id)
       and private.cleanup_user_eligible(u.id)
    on conflict (user_id) do nothing
    returning 1
  )
  select pg_catalog.count(*)::integer from candidates;
$$;

-- Phase 1: one batch. Returns how many organizations were deleted and how many users were queued.
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
  for org in
    select o.id from public.organizations o
     where o.kind = 'demo' and o.expires_at < pg_catalog.now()
     order by o.expires_at, o.id
     limit batch_size
     for update skip locked
  loop
    -- Queue every member user (a demo has one owner) BEFORE the cascade removes the memberships.
    insert into private.demo_cleanup_users (user_id)
    select m.user_id from public.memberships m where m.organization_id = org.id
    on conflict (user_id) do nothing;
    get diagnostics queued = row_count;
    perform private.clear_demo_data(org.id);
    delete from public.organizations where id = org.id and kind = 'demo' and expires_at < pg_catalog.now();
    deleted := deleted + 1;
  end loop;
  return pg_catalog.jsonb_build_object('orgs_deleted', deleted, 'batch_size', batch_size);
end;
$$;

-- Phase 2 helpers
create or replace function public.cleanup_next_users(max_rows integer, attempted_before timestamptz)
returns setof uuid
language sql
security definer
set search_path = ''
as $$
  select q.user_id from private.demo_cleanup_users q
   where q.last_attempt_at is null or q.last_attempt_at < attempted_before
   order by q.attempts, q.queued_at, q.user_id
   limit greatest(1, least(max_rows, 1000));
$$;

create or replace function public.cleanup_user_eligible(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select private.cleanup_user_eligible(uid) $$;

-- Records the outcome for a queued user: 'deleted' and 'skipped' remove the row; 'failed' keeps it for the next run.
create or replace function public.cleanup_record_user(uid uuid, outcome text, error_code text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if outcome in ('deleted', 'skipped') then
    delete from private.demo_cleanup_users where user_id = uid;
  elsif outcome = 'failed' then
    update private.demo_cleanup_users
       set attempts = attempts + 1, last_attempt_at = pg_catalog.now(), last_error = pg_catalog.left(coalesce(error_code, 'unknown'), 64)
     where user_id = uid;
  else
    raise exception 'unknown outcome %', outcome;
  end if;
end;
$$;

create or replace function public.cleanup_enqueue_orphans(min_age_hours integer default 48)
returns integer
language sql
security definer
set search_path = ''
as $$ select private.enqueue_orphan_guests(pg_catalog.make_interval(hours => greatest(1, min_age_hours))) $$;

create or replace function public.cleanup_queue_size()
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select pg_catalog.count(*)::integer from private.demo_cleanup_users $$;

-- Expired idempotency keys (the table arrives with SIT-183; until then there is nothing to purge). The convention
-- for that issue: private.idempotency_keys(expires_at timestamptz).
create or replace function public.cleanup_purge_expired_keys()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer := 0;
begin
  if pg_catalog.to_regclass('private.idempotency_keys') is not null then
    execute 'with gone as (delete from private.idempotency_keys where expires_at < pg_catalog.now() returning 1) select pg_catalog.count(*)::integer from gone' into n;
  end if;
  return n;
end;
$$;

revoke all on function private.cleanup_user_eligible(uuid), private.enqueue_orphan_guests(interval) from public, anon, authenticated;
revoke all on function public.cleanup_purge_expired_demos(integer), public.cleanup_next_users(integer, timestamptz),
  public.cleanup_user_eligible(uuid), public.cleanup_record_user(uuid, text, text), public.cleanup_enqueue_orphans(integer),
  public.cleanup_queue_size(), public.cleanup_purge_expired_keys() from public, anon, authenticated;
grant execute on function public.cleanup_purge_expired_demos(integer), public.cleanup_next_users(integer, timestamptz),
  public.cleanup_user_eligible(uuid), public.cleanup_record_user(uuid, text, text), public.cleanup_enqueue_orphans(integer),
  public.cleanup_queue_size(), public.cleanup_purge_expired_keys() to service_role;
grant execute on function private.cleanup_user_eligible(uuid), private.enqueue_orphan_guests(interval) to service_role;
