-- SIT-187: hardened helper functions for RLS policies and RPCs.
--
-- Rules every helper follows:
--  * lives in the `private` schema (never exposed through PostgREST, which serves only `public`);
--  * SECURITY DEFINER with `search_path = ''` and fully qualified names;
--  * takes no caller-supplied identity: the actor is always auth.uid() / the JWT, never an argument;
--  * EXECUTE is revoked from PUBLIC and anon and granted to authenticated and service_role only.
--
-- Recursion: the helpers read public.memberships / public.organizations as the function owner, which
-- bypasses RLS on those tables (tables are not FORCE ROW LEVEL SECURITY). Policies on memberships can
-- therefore call them without re-entering their own policy.

-- Policy expressions run as the calling role, which needs USAGE on the schema to resolve the
-- function. Nothing else in `private` is granted, so this exposes only the functions granted below.
grant usage on schema private to authenticated, service_role;

create or replace function private.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid();
$$;

create or replace function private.is_anonymous()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- is_anonymous is a boolean claim set by GoTrue for anonymous sign-ins. Missing or malformed means no.
  select coalesce((auth.jwt() ->> 'is_anonymous') = 'true', false);
$$;

create or replace function private.is_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function private.has_role(org_id uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.role = any (roles)
  );
$$;

create or replace function private.org_is_writable(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  -- Real organizations never expire; demo organizations are writable only before expires_at.
  select exists (
    select 1
    from public.organizations o
    where o.id = org_id
      and (o.kind = 'real' or o.expires_at > now())
  );
$$;

create or replace function private.can_write(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_role(org_id, array['owner', 'admin', 'member'])
     and private.org_is_writable(org_id);
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'private.current_user_id()',
    'private.is_anonymous()',
    'private.is_member(uuid)',
    'private.has_role(uuid, text[])',
    'private.org_is_writable(uuid)',
    'private.can_write(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;
