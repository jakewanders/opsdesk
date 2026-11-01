-- SIT-191: database support for the demo lifecycle (PRD 6.5, 8.1, 8.2).
--
-- One row per demo workspace, keyed by the anonymous identity that owns it. The unique `user_id` is the
-- arbiter when two bootstrap calls race: only one can insert. Expired demos keep their row until the
-- cleanup job removes the organization (the row cascades), so a fresh demo for the same identity is only
-- possible once the old one is gone: that is the "after cleanup rules allow" rule.

-- A composite key lets the mapping table prove the organization is a DEMO, not a real tenant.
alter table public.organizations add constraint organizations_id_kind_key unique (id, kind);

create table public.demo_workspaces (
  organization_id uuid not null,
  kind text not null default 'demo',
  user_id uuid not null,
  -- Version of the seed that populated the workspace; reset restores exactly this version.
  seed_version integer not null default 0,
  seeded_at timestamptz,
  -- Throttle state: one reset per minute per workspace.
  last_reset_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint demo_workspaces_pkey primary key (organization_id),
  constraint demo_workspaces_user_key unique (user_id),
  constraint demo_workspaces_organization_fkey foreign key (organization_id, kind)
    references public.organizations (id, kind) on delete cascade,
  constraint demo_workspaces_user_fkey foreign key (user_id) references auth.users (id) on delete cascade,
  constraint demo_workspaces_kind_demo check (kind = 'demo'),
  constraint demo_workspaces_seed_version_nonneg check (seed_version >= 0),
  constraint demo_workspaces_seeded_consistent check ((seed_version = 0) = (seeded_at is null))
);

comment on table public.demo_workspaces is
  'One row per demo workspace. user_id is unique: at most one demo per anonymous identity. Written only by trusted definer code.';

create trigger demo_workspaces_set_updated_at
  before update on public.demo_workspaces
  for each row execute function private.set_updated_at();

select private.protect_columns('public.demo_workspaces', 'organization_id', 'kind', 'user_id', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- Trusted-only columns: seed_version, seeded_at, last_reset_at (second line of defence behind the grants)
-- ---------------------------------------------------------------------------------------------
create or replace function private.prevent_untrusted_column_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
  old_row jsonb := pg_catalog.to_jsonb(old);
  new_row jsonb := pg_catalog.to_jsonb(new);
begin
  if current_user in ('postgres', 'supabase_admin', 'service_role') then
    return new;
  end if;
  foreach col in array tg_argv loop
    if not (new_row ? col) then
      raise exception 'Protected column "%" does not exist on %.%', col, tg_table_schema, tg_table_name;
    end if;
    if new_row -> col is distinct from old_row -> col then
      raise exception using errcode = 'OD403', message = 'This field cannot be changed.', detail = 'IMMUTABLE_COLUMN', hint = col;
    end if;
  end loop;
  return new;
end;
$$;

create trigger demo_workspaces_trusted_columns
  before update on public.demo_workspaces
  for each row execute function private.prevent_untrusted_column_change('seed_version', 'seeded_at', 'last_reset_at');

-- ---------------------------------------------------------------------------------------------
-- Grants and RLS: owner can read; nobody but trusted code writes
-- ---------------------------------------------------------------------------------------------
revoke all on table public.demo_workspaces from public, anon, authenticated;
grant select on table public.demo_workspaces to authenticated;
alter table public.demo_workspaces enable row level security;

create policy demo_workspaces_select_owner
  on public.demo_workspaces for select to authenticated
  using (user_id = (select auth.uid()));
create policy demo_workspaces_no_insert on public.demo_workspaces as restrictive for insert to authenticated with check (false);
create policy demo_workspaces_no_update on public.demo_workspaces as restrictive for update to authenticated using (false) with check (false);
create policy demo_workspaces_no_delete on public.demo_workspaces as restrictive for delete to authenticated using (false);

-- ---------------------------------------------------------------------------------------------
-- Trusted helpers (called by the bootstrap and reset RPCs, which run as the function owner)
-- ---------------------------------------------------------------------------------------------
-- The demo lifetime. expires_at = created_at + demo_ttl(), set only through set_demo_expiry (SIT-188).
create or replace function private.demo_ttl()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '24 hours' $$;

-- Registers the demo workspace for an identity. A second call for the same identity fails with 23505
-- (unique user_id), which is how a racing bootstrap learns it lost.
create or replace function private.register_demo_workspace(org_id uuid, owner_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.demo_workspaces (organization_id, user_id) values (org_id, owner_id);
end;
$$;

-- Records which seed version populated the workspace.
create or replace function private.record_demo_seed(org_id uuid, version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if version is null or version < 1 then
    raise exception using errcode = 'OD422', message = 'A seed version must be 1 or higher.', detail = 'SEED_VERSION_INVALID';
  end if;
  update public.demo_workspaces set seed_version = version, seeded_at = pg_catalog.now() where organization_id = org_id;
  if not found then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
end;
$$;

-- Atomically claims a reset: allowed when the last reset was at least a minute ago. The UPDATE is the lock,
-- so two simultaneous resets cannot both pass. Returns the claim time.
create or replace function private.begin_demo_reset(org_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed timestamptz;
  previous timestamptz;
begin
  update public.demo_workspaces
     set last_reset_at = pg_catalog.now()
   where organization_id = org_id
     and (last_reset_at is null or last_reset_at <= pg_catalog.now() - interval '1 minute')
  returning last_reset_at into claimed;
  if found then
    return claimed;
  end if;
  select last_reset_at into previous from public.demo_workspaces where organization_id = org_id;
  if not found then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  raise exception using
    errcode = 'OD429',
    message = 'You can reset the demo once a minute. Try again shortly.',
    detail = 'DEMO_RESET_THROTTLED',
    hint = 'retry-after=' || greatest(1, ceil(extract(epoch from (previous + interval '1 minute' - pg_catalog.now()))))::int;
end;
$$;

revoke all on function private.prevent_untrusted_column_change() from public, anon, authenticated;
revoke all on function private.demo_ttl() from public, anon, authenticated;
revoke all on function private.register_demo_workspace(uuid, uuid) from public, anon, authenticated;
revoke all on function private.record_demo_seed(uuid, integer) from public, anon, authenticated;
revoke all on function private.begin_demo_reset(uuid) from public, anon, authenticated;
grant execute on function private.demo_ttl() to service_role;
grant execute on function private.register_demo_workspace(uuid, uuid) to service_role;
grant execute on function private.record_demo_seed(uuid, integer) to service_role;
grant execute on function private.begin_demo_reset(uuid) to service_role;
