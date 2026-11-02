-- SIT-199 follow-up and SIT-198: one limits table for the whole app, then create_real_organization().

-- The limits table now serves more than demos.
alter table private.demo_limits rename to app_limits;
create or replace function private.app_limit(limit_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select l.value from private.app_limits l where l.key = limit_key $$;
revoke all on function private.app_limit(text) from public, anon, authenticated;
grant execute on function private.app_limit(text) to service_role;
-- Kept as the name the bootstrap RPC already calls.
create or replace function private.demo_limit(limit_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select private.app_limit(limit_key) $$;
insert into private.app_limits (key, value, note) values
  ('max_real_orgs_per_user', 5, 'Most real organizations one user may create; a guard against abuse of the checked creation RPC.');

-- ---------------------------------------------------------------------------------------------
-- public.create_real_organization(name, industry, timezone)
-- ---------------------------------------------------------------------------------------------
-- Registered (non-anonymous) users only. The signature carries no owner, organization or user id: the owner is
-- auth.uid(), kind is 'real', there is no expiry, the currency is the table's fixed USD. The organization and the
-- caller's owner membership are inserted in one transaction, so a failure leaves nothing behind (and the deferred
-- last-owner guard would refuse an ownerless organization at commit anyway).
create or replace function public.create_real_organization(
  org_name text,
  org_industry text default null,
  org_timezone text default 'UTC'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  guest boolean;
  clean_name text := pg_catalog.btrim(normalize(coalesce(org_name, ''), nfc));
  clean_industry text := nullif(pg_catalog.btrim(normalize(coalesce(org_industry, ''), nfc)), '');
  zone text := coalesce(nullif(pg_catalog.btrim(coalesce(org_timezone, '')), ''), 'UTC');
  owned integer;
  new_org uuid;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to create a workspace.', detail = 'NOT_SIGNED_IN';
  end if;

  -- Not for guests: the signed claim and the stored user must both say registered.
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if private.is_anonymous() or guest is distinct from false then
    raise exception using errcode = 'OD403', message = 'Create an account to keep your data. Guests cannot create workspaces.', detail = 'ACCOUNT_REQUIRED';
  end if;

  -- Validation (the API validates first with friendlier field errors; this is the backstop).
  if pg_catalog.char_length(clean_name) not between 2 and 80
     or clean_name ~ '[[:cntrl:]]'
     or clean_name ~ '<[A-Za-z/!?]' then
    raise exception using errcode = 'OD422', message = 'Workspace name must be 2 to 80 characters of plain text.', detail = 'INVALID_NAME';
  end if;
  if clean_industry is not null
     and (pg_catalog.char_length(clean_industry) > 80 or clean_industry ~ '[[:cntrl:]]' or clean_industry ~ '<[A-Za-z/!?]') then
    raise exception using errcode = 'OD422', message = 'Industry must be 80 characters or fewer of plain text.', detail = 'INVALID_INDUSTRY';
  end if;
  if not private.is_valid_timezone(zone) then
    raise exception using errcode = 'OD422', message = 'Choose a valid time zone.', detail = 'INVALID_TIMEZONE';
  end if;

  -- Serialize this user's creations so the per-user limit cannot be raced past.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.org.create:' || uid::text, 0));
  select pg_catalog.count(*) into owned from public.organizations o where o.created_by = uid and o.kind = 'real';
  if owned >= coalesce(private.app_limit('max_real_orgs_per_user'), 5) then
    raise exception using errcode = 'OD429', message = 'You have reached the limit of workspaces for one account.', detail = 'ORG_LIMIT';
  end if;

  insert into public.organizations (name, industry, timezone, kind, expires_at, created_by)
  values (clean_name, clean_industry, zone, 'real', null, uid)
  returning id into new_org;
  insert into public.memberships (organization_id, user_id, role) values (new_org, uid, 'owner');

  return new_org;
end;
$$;

revoke all on function public.create_real_organization(text, text, text) from public, anon;
grant execute on function public.create_real_organization(text, text, text) to authenticated, service_role;
comment on function public.create_real_organization(text, text, text) is
  'Creates a real organization owned by the calling registered user. No owner or id parameters; one transaction; per-user limit.';
