-- SIT-178: the tenancy core. organizations and memberships (PRD 6.1) with the constraints that
-- later RLS, RPC, and composite-foreign-key work relies on.
--
-- Both tables are created CLOSED: RLS is on, no policies exist, and every API role has no
-- privileges. SIT-194 adds the policies and the minimal grants. Until then only trusted server
-- code (the service role, SECURITY DEFINER functions) can touch them.

-- ---------------------------------------------------------------------------------------------
-- Timezone validation helper. A CHECK constraint cannot query pg_timezone_names directly, so it
-- calls this function. Constraints run as the role that writes the row, so that role needs
-- EXECUTE (granted below); the function itself reads only a public catalog view.
-- IANA names only: "America/New_York" and "UTC" pass; abbreviations ("EST"), legacy aliases
-- without a slash, and the posix/ and right/ duplicates do not.
-- ---------------------------------------------------------------------------------------------
create or replace function private.is_valid_timezone(tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select tz is not null
    and (tz = 'UTC' or (tz like '%/%' and tz !~ '^(posix|right)/'))
    and exists (select 1 from pg_catalog.pg_timezone_names n where n.name = tz);
$$;
revoke all on function private.is_valid_timezone(text) from public, anon, authenticated;
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------------------------
create table public.organizations (
  id uuid not null default gen_random_uuid(),
  name varchar(80) not null,
  slug text,
  industry text,
  timezone text not null default 'UTC',
  currency char(3) not null default 'USD',
  kind text not null default 'real',
  created_by uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_pkey primary key (id),
  constraint organizations_slug_key unique (slug),
  constraint organizations_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  constraint organizations_name_length check (char_length(btrim(name)) >= 2),
  constraint organizations_slug_format check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint organizations_slug_length check (slug is null or char_length(slug) <= 63),
  constraint organizations_industry_length check (industry is null or char_length(btrim(industry)) between 1 and 80),
  constraint organizations_timezone_iana check (private.is_valid_timezone(timezone)),
  constraint organizations_currency_usd check (currency = 'USD'),
  constraint organizations_kind_values check (kind in ('real', 'demo')),
  -- A demo organization always expires; a real one never does.
  constraint organizations_demo_requires_expiry check (kind <> 'demo' or expires_at is not null),
  constraint organizations_real_forbids_expiry check (kind <> 'real' or expires_at is null)
);

comment on table public.organizations is
  'A tenant. kind = real (permanent) or demo (disposable, expires_at required). The slug is cosmetic and never used for authorization.';

create index organizations_created_by_idx on public.organizations (created_by);
-- The expired-demo cleanup scans demo organizations by expiry.
create index organizations_demo_expiry_idx on public.organizations (expires_at) where kind = 'demo';

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------------------------
create table public.memberships (
  organization_id uuid not null,
  user_id uuid not null,
  role text not null,
  joined_at timestamptz not null default now(),
  constraint memberships_pkey primary key (organization_id, user_id),
  constraint memberships_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint memberships_user_id_fkey foreign key (user_id) references auth.users (id) on delete cascade,
  constraint memberships_role_values check (role in ('owner', 'admin', 'member', 'viewer'))
);

comment on table public.memberships is
  'Who belongs to which organization, with what role. Never written directly by API roles: invitation and membership RPCs only (SIT-202).';

-- "Which organizations does this user belong to?" (the primary RLS lookup) and
-- "who are the owners/admins of this organization?".
create index memberships_user_org_idx on public.memberships (user_id, organization_id);
create index memberships_org_role_idx on public.memberships (organization_id, role);

-- ---------------------------------------------------------------------------------------------
-- Last-owner guard: an organization must always keep at least one owner. A DEFERRED constraint
-- trigger checks at commit, so one transaction may create an organization and its first owner,
-- or hand ownership from one person to another. It is a safety net under the membership RPC
-- (SIT-202), which gives the friendly error first. Deleting a whole organization (cascading its
-- memberships) is fine; so is deleting the organization's last remaining account only if the
-- organization goes with it.
-- ---------------------------------------------------------------------------------------------
create or replace function private.assert_org_has_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  org uuid;
  orgs uuid[];
begin
  if tg_op = 'DELETE' then
    orgs := array[old.organization_id];
  elsif tg_table_name = 'organizations' then
    orgs := array[new.id];
  else
    orgs := array[new.organization_id, old.organization_id];
  end if;

  foreach org in array orgs loop
    if exists (select 1 from public.organizations o where o.id = org)
       and not exists (
         select 1 from public.memberships m where m.organization_id = org and m.role = 'owner'
       ) then
      raise exception using
        errcode = 'OD409',
        message = 'An organization must keep at least one owner.',
        detail = 'LAST_OWNER';
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function private.assert_org_has_owner() from public, anon, authenticated;

create constraint trigger organizations_must_have_owner
  after insert on public.organizations
  deferrable initially deferred
  for each row execute function private.assert_org_has_owner();

create constraint trigger memberships_keep_an_owner
  after update of role, organization_id or delete on public.memberships
  deferrable initially deferred
  for each row execute function private.assert_org_has_owner();

-- ---------------------------------------------------------------------------------------------
-- Closed by default (see the header). SIT-194 opens exactly what is needed.
-- ---------------------------------------------------------------------------------------------
revoke all on table public.organizations from public, anon, authenticated;
revoke all on table public.memberships from public, anon, authenticated;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
