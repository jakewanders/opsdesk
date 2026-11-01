-- SIT-194: invert Supabase's open defaults and write the RLS policies for the tenancy tables.
-- This file is the template every business table copies (see docs/SECURITY.md).

-- ---------------------------------------------------------------------------------------------
-- 1. Start from no privileges
-- ---------------------------------------------------------------------------------------------
-- Existing objects in public: nothing for anon; authenticated gets explicit grants below.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all tables in schema public from authenticated;

-- Future objects created by the migration role: new tables, sequences and functions start with NO
-- access for the API roles (service_role keeps its defaults). Every new table or RPC must grant
-- exactly what it needs. EXECUTE on functions is also withheld from PUBLIC, the Postgres default.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------
-- 2. profiles (policies and column grants already exist from SIT-167; restated here as the contract)
-- ---------------------------------------------------------------------------------------------
-- select: own row. update: display_name and avatar_url on own row. No insert, no delete.
revoke all on table public.profiles from public, anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. organizations
-- ---------------------------------------------------------------------------------------------
-- select: members of the organization (including an expired demo, so a guest can see why).
-- update: owner/admin of a REAL organization whose settings are writable; only name, industry and
--         timezone are granted, so kind, expiry, creator and id cannot be written at all (and the
--         immutability triggers refuse them even for a role that had the grant).
-- insert/delete: no grant and no policy. Creation goes through checked RPCs, deletion through cleanup.
revoke all on table public.organizations from public, anon, authenticated;
grant select on table public.organizations to authenticated;
grant update (name, industry, timezone) on table public.organizations to authenticated;

create policy organizations_select_member
  on public.organizations
  for select
  to authenticated
  using (private.is_member(id));

create policy organizations_update_admin
  on public.organizations
  for update
  to authenticated
  using (
    private.has_role(id, array['owner', 'admin'])
    and private.org_is_writable(id)
    -- Demo guests may not edit organization settings (PRD 5.1 matrix); they are anonymous users.
    and not private.is_anonymous()
  )
  with check (
    private.has_role(id, array['owner', 'admin'])
    and private.org_is_writable(id)
    and not private.is_anonymous()
  );

-- Explicit denials, so the intent is on the page and a later careless grant still cannot open them.
create policy organizations_no_insert on public.organizations as restrictive for insert to authenticated with check (false);
create policy organizations_no_delete on public.organizations as restrictive for delete to authenticated using (false);

-- ---------------------------------------------------------------------------------------------
-- 4. memberships: read-only for clients
-- ---------------------------------------------------------------------------------------------
-- Role changes, invitations and removals happen only through validated RPCs (M4).
revoke all on table public.memberships from public, anon, authenticated;
grant select on table public.memberships to authenticated;

create policy memberships_select_same_org
  on public.memberships
  for select
  to authenticated
  using (private.is_member(organization_id));

create policy memberships_no_insert on public.memberships as restrictive for insert to authenticated with check (false);
create policy memberships_no_update on public.memberships as restrictive for update to authenticated using (false) with check (false);
create policy memberships_no_delete on public.memberships as restrictive for delete to authenticated using (false);

-- FORCE ROW LEVEL SECURITY is deliberately NOT used: the table owner (postgres) runs the SECURITY
-- DEFINER helpers and RPCs that must read and write across tenants, and it has BYPASSRLS anyway.
-- API roles are not owners, so RLS always applies to them.
