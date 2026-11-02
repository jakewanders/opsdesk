-- SIT-208: customers, the first business table and the pattern for opportunities, tasks and quotes (PRD 6.2, US-03).
--
-- Archive is the only delete: `archived_at` is set and cleared by update; no API role holds DELETE.
-- Email is normalized (trimmed, lower case) by a trigger and is deliberately NOT unique: a duplicate e-mail is only a
-- warning in the application (two people can share a family address).

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
-- 0 to 10 tags, each 1 to 30 characters after trimming, none null.
create or replace function private.valid_tags(tags text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select tags is not null
     and pg_catalog.cardinality(tags) <= 10
     and not exists (select 1 from pg_catalog.unnest(tags) t where t is null or pg_catalog.char_length(pg_catalog.btrim(t)) not between 1 and 30)
$$;
revoke all on function private.valid_tags(text[]) from public, anon, authenticated;
grant execute on function private.valid_tags(text[]) to authenticated, service_role;  -- evaluated inside the table's CHECK

create table public.customers (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  type text not null default 'person',
  display_name text not null,
  company_name text,
  email text,
  phone text,
  website text,
  status text not null default 'lead',
  source text not null default 'other',
  tags text[] not null default '{}',
  notes text,
  assigned_to uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint customers_pkey primary key (id),
  -- children (opportunities, tasks, quotes) reference (organization_id, id), so a link can never cross tenants
  constraint customers_org_id_key unique (organization_id, id),
  constraint customers_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint customers_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  -- the assignee must be a member of the SAME organization; removing the member clears only the assignment
  constraint customers_assigned_to_fkey foreign key (organization_id, assigned_to)
    references public.memberships (organization_id, user_id) on delete set null (assigned_to),
  constraint customers_type_values check (type in ('person', 'company')),
  constraint customers_display_name_length check (pg_catalog.char_length(pg_catalog.btrim(display_name)) between 2 and 120),
  constraint customers_company_name_length check (company_name is null or pg_catalog.char_length(pg_catalog.btrim(company_name)) between 1 and 120),
  constraint customers_email_format check (email is null or (pg_catalog.char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  constraint customers_email_normalized check (email is null or email = pg_catalog.lower(pg_catalog.btrim(email))),
  constraint customers_phone_length check (phone is null or pg_catalog.char_length(pg_catalog.btrim(phone)) between 1 and 40),
  -- http(s) only: a stored `javascript:` link could never be rendered safely
  constraint customers_website_format check (website is null or (pg_catalog.char_length(website) <= 255 and website ~* '^https?://[^[:space:]]+$')),
  constraint customers_status_values check (status in ('lead', 'active', 'inactive')),
  constraint customers_source_values check (source in ('referral', 'website', 'outbound', 'other')),
  constraint customers_tags_valid check (private.valid_tags(tags)),
  constraint customers_notes_length check (notes is null or pg_catalog.char_length(notes) <= 5000)
);

create index customers_org_archived_updated_idx on public.customers (organization_id, archived_at, updated_at desc);
create index customers_org_status_idx on public.customers (organization_id, status);
create index customers_org_assigned_idx on public.customers (organization_id, assigned_to) where assigned_to is not null;
-- Name, company and e-mail search ("acm" finds "Acme Plumbing"): trigram over one normalized expression.
create index customers_search_trgm_idx on public.customers using gin (
  (pg_catalog.lower(display_name || ' ' || coalesce(company_name, '') || ' ' || coalesce(email, ''))) extensions.gin_trgm_ops
);

comment on table public.customers is 'Customers and leads of an organization. Soft-deleted through archived_at; e-mail is not unique.';

-- ---------------------------------------------------------------------------------------------
-- Normalization (runs before the CHECKs see the row)
-- ---------------------------------------------------------------------------------------------
create or replace function private.normalize_customer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.display_name := pg_catalog.btrim(new.display_name);
  new.company_name := nullif(pg_catalog.btrim(new.company_name), '');
  new.email := nullif(pg_catalog.lower(pg_catalog.btrim(new.email)), '');
  new.phone := nullif(pg_catalog.btrim(new.phone), '');
  new.website := nullif(pg_catalog.btrim(new.website), '');
  if new.tags is not null then
    new.tags := array(select pg_catalog.btrim(t) from pg_catalog.unnest(new.tags) t where t is not null and pg_catalog.btrim(t) <> '');
  end if;
  return new;
end;
$$;
revoke all on function private.normalize_customer() from public, anon, authenticated;

create trigger customers_normalize before insert or update on public.customers
  for each row execute function private.normalize_customer();
create trigger customers_set_updated_at before update on public.customers
  for each row execute function private.set_updated_at();
select private.protect_columns('public.customers', 'id', 'organization_id', 'created_by', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- Access: members read; owner, admin and member write while the workspace is writable; viewers read only.
-- No DELETE for anyone through the API (archive instead), and the creator is always the caller.
-- ---------------------------------------------------------------------------------------------
select private.attach_tenant_rls('public.customers');
drop policy customers_delete_writer on public.customers;
revoke delete on table public.customers from authenticated;
create policy customers_insert_creator on public.customers
  as restrictive for insert to authenticated
  with check (created_by is not distinct from auth.uid());

-- Demo workspaces hold at most 50 customers (archived ones count), and every change is logged.
select private.attach_demo_cap('public.customers', 'demo_cap_customers');
select private.attach_activity_log(
  'public.customers', 'customer', 'display_name',
  array['display_name', 'company_name', 'type', 'status', 'source', 'assigned_to'],
  array['email', 'phone', 'website', 'notes', 'tags'],
  'archived_at'
);

-- ---------------------------------------------------------------------------------------------
-- Demo seed: exactly 18 customers per workspace (PRD 8.2). Deterministic fictional data from the fixture functions:
-- 12 companies and 6 people, example.com addresses, 555-01xx phones, mixed status and source, three archived,
-- some assigned to the workspace owner.
-- ---------------------------------------------------------------------------------------------
create or replace function private.seed_customers(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  i integer;
  statuses text[] := array['active', 'lead', 'active', 'inactive', 'lead', 'active', 'active', 'lead', 'inactive'];
  sources text[] := array['referral', 'website', 'outbound', 'other'];
  tag_sets text[] := array['residential', 'commercial,priority', 'residential,repeat', 'commercial', 'new-build', 'residential'];
  notes text[] := array[
    'Prefers morning appointments.', 'Asked for a seasonal maintenance plan.', 'Referred by a neighbour.',
    'Large property with several buildings.', 'Wants a written estimate before any work.', 'Always pays by bank transfer.'
  ];
begin
  select m.user_id into owner_id from public.memberships m where m.organization_id = org_id and m.role = 'owner' order by m.user_id limit 1;
  for i in 1..18 loop
    insert into public.customers (
      organization_id, type, display_name, company_name, email, phone, website, status, source, tags, notes,
      assigned_to, created_by, created_at, updated_at, archived_at
    ) values (
      org_id,
      case when i <= 12 then 'company' else 'person' end,
      case when i <= 12 then private.demo_company(i) else private.demo_person(i) end,
      case when i > 12 then private.demo_company(i) else null end,
      private.demo_email(i),
      private.demo_phone(i),
      case when i <= 12 and i % 2 = 0 then 'https://www.example.com/' || pg_catalog.lower(pg_catalog.regexp_replace(private.demo_company(i), '[^A-Za-z0-9]+', '-', 'g')) else null end,
      statuses[((i - 1) % 9) + 1],
      sources[((i - 1) % 4) + 1],
      pg_catalog.string_to_array(tag_sets[((i - 1) % 6) + 1], ','),
      notes[((i - 1) % 6) + 1],
      case when i % 3 = 0 then owner_id else null end,
      null,
      private.demo_ts(90 - (i * 4), 9),
      private.demo_ts(greatest(0, 60 - (i * 3)), 14),
      case when i in (4, 9, 17) then private.demo_ts(3, 11) else null end
    );
  end loop;
end;
$$;
create or replace function private.clear_customers(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.customers where organization_id = org_id;
end;
$$;
revoke all on function private.seed_customers(uuid), private.clear_customers(uuid) from public, anon, authenticated;
select private.register_demo_seeder('customers', 10, 'private.seed_customers(uuid)'::regprocedure, 1, 'private.clear_customers(uuid)'::regprocedure);
