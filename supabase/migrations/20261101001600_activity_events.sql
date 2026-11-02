-- SIT-195: the activity/audit store (PRD 6.2, 5.3). Append-only, read-only for members, written only by controlled
-- database logic (the logging mechanism arrives with SIT-201 as SECURITY DEFINER functions and triggers).
--
-- Why `entity_id` is NOT a foreign key: an event must outlive the row it describes. Entities are archived (and the demo
-- cleanup deletes whole workspaces), and "customer X was archived" is exactly the history a person wants to keep
-- reading. The organization IS a foreign key, so deleting an organization (demo cleanup) removes its events with it.

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  summary text not null,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Extend either list with a migration when a new entity or action ships.
  constraint activity_events_entity_type_check check (entity_type in ('customer', 'opportunity', 'task', 'quote')),
  constraint activity_events_action_check check (action in (
    'created', 'updated', 'archived', 'restored', 'deleted', 'stage_changed', 'completed', 'reopened',
    'sent', 'approved', 'rejected', 'imported'
  )),
  constraint activity_events_summary_check check (pg_catalog.char_length(summary) between 1 and 300),
  -- A narrow object, never a document: the logger stores only whitelisted field names and short values.
  constraint activity_events_changes_object check (pg_catalog.jsonb_typeof(changes) = 'object'),
  constraint activity_events_changes_size check (pg_catalog.octet_length(changes::text) <= 4096)
);

create index activity_events_org_created_idx on public.activity_events (organization_id, created_at desc);
create index activity_events_org_entity_idx on public.activity_events (organization_id, entity_type, entity_id);

comment on table public.activity_events is
  'Append-only activity history. Members read; nobody writes through the API. Rows are inserted by definer functions.';

-- ---------------------------------------------------------------------------------------------
-- Access: members read their organization's events. No other grant exists for any API role.
-- ---------------------------------------------------------------------------------------------
alter table public.activity_events enable row level security;
revoke all on table public.activity_events from public, anon, authenticated;
grant select on table public.activity_events to authenticated;

create policy activity_events_select_member on public.activity_events
  for select to authenticated
  using (private.is_member(organization_id));

-- ---------------------------------------------------------------------------------------------
-- History cannot be rewritten. SECURITY INVOKER on purpose: it must see who is really running the statement.
--   UPDATE   always refused, for everyone.
--   DELETE   refused unless the caller is a trusted server role: the demo reset and cleanup run as the function owner,
--            and an organization's removal cascades its events.
--   TRUNCATE same rule as DELETE.
-- Even if a grant or policy were widened by mistake, this still stops a browser role.
-- ---------------------------------------------------------------------------------------------
create or replace function private.protect_activity_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception using errcode = 'OD403', message = 'Activity history cannot be changed.', detail = 'HISTORY_IMMUTABLE';
  end if;
  if current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using errcode = 'OD403', message = 'Activity history cannot be deleted.', detail = 'HISTORY_IMMUTABLE';
  end if;
  if tg_op = 'TRUNCATE' then
    return null;
  end if;
  return old;
end;
$$;
revoke all on function private.protect_activity_history() from public, anon, authenticated;

create trigger activity_events_protect_row
  before update or delete on public.activity_events
  for each row execute function private.protect_activity_history();
create trigger activity_events_protect_truncate
  before truncate on public.activity_events
  for each statement execute function private.protect_activity_history();

-- ---------------------------------------------------------------------------------------------
-- Demo protections: the activity cap (private.app_limits `demo_cap_activity_events`), and a reset that clears the
-- workspace's events (the seed itself writes no events yet; entity seeders log their own through SIT-201).
-- ---------------------------------------------------------------------------------------------
select private.attach_demo_cap('public.activity_events', 'demo_cap_activity_events');

create or replace function private.clear_activity_events(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.activity_events where organization_id = org_id;
end;
$$;
create or replace function private.seed_activity_events(org_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  null; -- history is produced by the entities' own seed inserts; nothing is invented here
end;
$$;
revoke all on function private.clear_activity_events(uuid), private.seed_activity_events(uuid) from public, anon, authenticated;
-- Position 990: cleared first on reset (reverse order), so entity clears and seeds never fight stale events.
select private.register_demo_seeder('activity_events', 990, 'private.seed_activity_events(uuid)'::regprocedure, 1, 'private.clear_activity_events(uuid)'::regprocedure);
