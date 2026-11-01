-- SIT-192: the demo seed registry and deterministic fictional-data fixtures (PRD 8.2).
--
-- One mechanism seeds a demo workspace for both bootstrap (SIT-199) and reset (SIT-205).
-- Entity issues add their rows by registering ONE function:
--
--   create function private.seed_customers(org_id uuid) returns void ... ;   -- uses the fixtures below
--   select private.register_demo_seeder('customers', 10, 'private.seed_customers(uuid)'::regprocedure);
--
-- A seeder runs in the caller's transaction, so a failing seeder rolls the whole seed back.

-- ---------------------------------------------------------------------------------------------
-- Registry (no grants: only migrations and the definer runner touch it)
-- ---------------------------------------------------------------------------------------------
create table private.demo_seeders (
  name text not null,
  position integer not null,
  fn regprocedure not null,
  -- Bump when the seeder's content changes, so reset restores the new seed.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  constraint demo_seeders_pkey primary key (name),
  constraint demo_seeders_position_key unique (position),
  constraint demo_seeders_name_format check (name ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint demo_seeders_version_positive check (version >= 1)
);
revoke all on table private.demo_seeders from public, anon, authenticated;

-- Registers (or replaces) a seeder. Lower positions run first, so a parent table is seeded before its children.
create or replace function private.register_demo_seeder(seeder_name text, seeder_position integer, seeder_fn regprocedure, seeder_version integer default 1)
returns void
language sql
set search_path = ''
as $$
  insert into private.demo_seeders (name, position, fn, version)
  values (seeder_name, seeder_position, seeder_fn, seeder_version)
  on conflict (name) do update set position = excluded.position, fn = excluded.fn, version = excluded.version;
$$;
revoke all on function private.register_demo_seeder(text, integer, regprocedure, integer) from public, anon, authenticated;

-- The seed version stored with a workspace: 1 for the framework, plus the version of every registered seeder.
create or replace function private.demo_seed_version()
returns integer
language sql
stable
set search_path = ''
as $$ select 1 + coalesce(sum(version), 0)::integer from private.demo_seeders $$;
revoke all on function private.demo_seed_version() from public, anon, authenticated;
grant execute on function private.demo_seed_version() to service_role;

-- ---------------------------------------------------------------------------------------------
-- Deterministic fictional fixtures
-- ---------------------------------------------------------------------------------------------
-- Rules (PRD 8.2): invented company names, example.com addresses, phone numbers in the reserved fictional
-- 555-0100..0199 range, no real people. Index i is 1-based and wraps after 24, so the same i always gives the
-- same value (no random()).
create or replace function private.demo_company(i integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select (array[
    'Quillmere Plumbing', 'Brannock & Vale HVAC', 'Tessaly Roofing', 'Orlindor Electric', 'Fennimore Landscaping',
    'Halvard Painting', 'Marrowgate Cleaning', 'Pellucid Windows', 'Vantrell Moving', 'Ashgrove Pest Control',
    'Dunmere Flooring', 'Kestrel Ridge Contracting', 'Lowenna Tile & Stone', 'Ostrander Garage Doors', 'Pemberlin Pool Service',
    'Rookhaven Fencing', 'Sallowfield Masonry', 'Thistledown Carpentry', 'Underhill Gutter Works', 'Wexcombe Insulation',
    'Yarrowby Paving', 'Zephyrine Solar', 'Ambrowick Drywall', 'Corvane Appliance Repair'
  ])[((i - 1) % 24) + 1]
$$;

create or replace function private.demo_first_name(i integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select (array[
    'Ada', 'Bram', 'Cleo', 'Dara', 'Elio', 'Faye', 'Gideon', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lena',
    'Milo', 'Nora', 'Otis', 'Pia', 'Quinn', 'Rhea', 'Soren', 'Tess', 'Uma', 'Vik', 'Wren', 'Yara'
  ])[((i - 1) % 24) + 1]
$$;

create or replace function private.demo_last_name(i integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select (array[
    'Aldermoor', 'Bexley-Rowe', 'Calloway-Finch', 'Dunhallow', 'Eskerfield', 'Farnsworth-Lund', 'Gresham-Pike', 'Hollowell',
    'Ingleby', 'Jorvik', 'Kettleridge', 'Lorrimer', 'Marchbanks', 'Nettlefold', 'Oakhurst-Vane', 'Pennyroyal',
    'Quarrington', 'Ravenscar', 'Stainforth', 'Tolliver-Marsh', 'Underwood-Hale', 'Verrington', 'Whitlock-Drey', 'Yelverton'
  ])[(((i - 1) * 7) % 24) + 1]
$$;

create or replace function private.demo_person(i integer)
returns text
language sql
immutable
set search_path = ''
as $$ select private.demo_first_name(i) || ' ' || private.demo_last_name(i) $$;

-- first.last@example.com: example.com is reserved for documentation and never delivers.
create or replace function private.demo_email(i integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(private.demo_first_name(i)) || '.' || pg_catalog.lower(pg_catalog.replace(private.demo_last_name(i), '-', '')) || '@example.com'
$$;

-- (202) 555-01NN: the 555-0100 to 555-0199 block is reserved for fiction.
create or replace function private.demo_phone(i integer)
returns text
language sql
immutable
set search_path = ''
as $$ select '(202) 555-01' || pg_catalog.lpad((((i - 1) % 100))::text, 2, '0') $$;

-- A fixed relative moment: `days_ago` days before today at `at_hour` o'clock (database time zone). Spread the
-- offsets over 0..90 days. Within one transaction now() is constant, so two seeds in one run agree exactly.
create or replace function private.demo_ts(days_ago integer, at_hour integer default 9)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select pg_catalog.date_trunc('day', pg_catalog.now()) - pg_catalog.make_interval(days => days_ago) + pg_catalog.make_interval(hours => at_hour)
$$;

-- ---------------------------------------------------------------------------------------------
-- The runner
-- ---------------------------------------------------------------------------------------------
-- Seeds `org_id` with every registered seeder, in order, inside the CALLER's transaction. The caller (a
-- definer RPC) passes the organization it has already validated; this function re-checks that it is a demo
-- workspace and refuses anything else. A workspace already seeded at the current version is left alone.
create or replace function private.seed_demo_workspace(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_kind text;
  current_version integer := private.demo_seed_version();
  seeder record;
begin
  select o.kind into org_kind from public.organizations o where o.id = org_id;
  if org_kind is null then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  if org_kind <> 'demo' then
    raise exception using errcode = 'OD403', message = 'Only demo workspaces can be seeded.', detail = 'NOT_A_DEMO';
  end if;
  if not exists (select 1 from public.demo_workspaces w where w.organization_id = org_id) then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  -- Idempotent: the marker is the stored seed version.
  if exists (select 1 from public.demo_workspaces w where w.organization_id = org_id and w.seed_version >= current_version) then
    return;
  end if;

  for seeder in select s.fn from private.demo_seeders s order by s.position loop
    execute pg_catalog.format('select %s($1)', seeder.fn::regproc::text) using org_id;
  end loop;

  perform private.record_demo_seed(org_id, current_version);
end;
$$;

-- Clears the marker so the next seed_demo_workspace call seeds again (reset empties the data first).
create or replace function private.clear_demo_seed_marker(org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.demo_workspaces set seed_version = 0, seeded_at = null where organization_id = org_id;
$$;

revoke all on function private.demo_company(integer), private.demo_first_name(integer), private.demo_last_name(integer),
  private.demo_person(integer), private.demo_email(integer), private.demo_phone(integer), private.demo_ts(integer, integer),
  private.seed_demo_workspace(uuid), private.clear_demo_seed_marker(uuid) from public, anon, authenticated;
grant execute on function private.demo_company(integer), private.demo_first_name(integer), private.demo_last_name(integer),
  private.demo_person(integer), private.demo_email(integer), private.demo_phone(integer), private.demo_ts(integer, integer),
  private.seed_demo_workspace(uuid), private.clear_demo_seed_marker(uuid) to service_role;
