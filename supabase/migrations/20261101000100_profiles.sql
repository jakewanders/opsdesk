-- SIT-167: profiles, the auth-user trigger, and row level security.
--
-- A profile is created for every new auth.users row, real or anonymous. It never stores the
-- email address. Users may read and update only their own row, and only two columns.

-- ---------------------------------------------------------------------------------------------
-- Private schema for helper and trigger functions. It is not in the API's exposed schemas
-- (supabase/config.toml [api].schemas), and no API role can use it.
-- ---------------------------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Reusable updated_at maintenance. SECURITY INVOKER: it only touches the row being updated.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------------------------
create table public.profiles (
  id uuid not null,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete cascade,
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 120),
  constraint profiles_avatar_url_https check (
    avatar_url is null or (avatar_url ~ '^https://' and char_length(avatar_url) <= 2048)
  )
);

comment on table public.profiles is
  'One row per auth user. Own-row access only; display_name and avatar_url are the only client-writable columns.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Trigger on auth.users: create the profile
-- ---------------------------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  default_name text;
begin
  if new.is_anonymous then
    default_name := 'Demo User';
  else
    -- Email local part only; the address itself is never copied into public.profiles.
    default_name := pg_catalog.left(
      coalesce(nullif(pg_catalog.split_part(coalesce(new.email, ''), '@', 1), ''), 'New user'),
      120
    );
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, default_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

-- Only the trigger (running as the function owner) may call it.
revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------------------------
-- Supabase's default privileges grant everything on new public tables to the API roles.
-- Start from nothing and grant exactly what is needed.
revoke all on table public.profiles from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;
-- No insert or delete grants: profiles are created by the trigger and removed by the cascade.

alter table public.profiles enable row level security;

create policy profiles_select_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create policy profiles_update_own
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
