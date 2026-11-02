-- SIT-216: opportunities (deals), with same-tenant integrity enforced by the database (PRD 6.2, 6.4, US-04).
-- Follows the customers pattern: composite keys, normalization, RLS with no delete (archive only), protected columns,
-- demo cap (30), activity logging, and a deterministic demo seed (10 opportunities).

create table public.opportunities (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  title text not null,
  description text,
  stage text not null default 'new',
  amount_cents bigint not null default 0,
  probability_percent smallint,
  expected_close_date date,
  assigned_to uuid,
  lost_reason text,
  closed_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint opportunities_pkey primary key (id),
  constraint opportunities_org_id_key unique (organization_id, id),
  constraint opportunities_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint opportunities_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  -- A deal's customer must be in the SAME organization: a cross-tenant customer is impossible. A customer that has
  -- deals cannot be deleted (customers are archived, never deleted), so history is never orphaned; removing a whole
  -- organization removes both in one statement.
  constraint opportunities_customer_fkey foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint opportunities_assigned_to_fkey foreign key (organization_id, assigned_to)
    references public.memberships (organization_id, user_id) on delete set null (assigned_to),
  constraint opportunities_title_length check (pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 150),
  constraint opportunities_description_length check (description is null or pg_catalog.char_length(description) <= 5000),
  constraint opportunities_stage_values check (stage in ('new', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  -- whole cents, at most 1,000,000,000.00 (the same ceiling as the API)
  constraint opportunities_amount_range check (amount_cents between 0 and 100000000000),
  constraint opportunities_probability_range check (probability_percent between 0 and 100),
  -- lost needs a reason, and only lost has one
  constraint opportunities_lost_reason_required check (stage <> 'lost' or pg_catalog.char_length(pg_catalog.btrim(coalesce(lost_reason, ''))) between 1 and 500),
  constraint opportunities_lost_reason_only_when_lost check (stage = 'lost' or lost_reason is null),
  -- closed_at is set exactly when the deal is won or lost
  constraint opportunities_closed_at_matches_stage check ((stage in ('won', 'lost')) = (closed_at is not null))
);

create index opportunities_org_stage_archived_idx on public.opportunities (organization_id, stage, archived_at);
create index opportunities_org_customer_idx on public.opportunities (organization_id, customer_id);
create index opportunities_org_close_date_idx on public.opportunities (organization_id, expected_close_date);
create index opportunities_org_archived_updated_idx on public.opportunities (organization_id, archived_at, updated_at desc);

comment on table public.opportunities is 'Deals. Soft-deleted through archived_at. Same-organization customer and assignee are enforced by composite foreign keys.';

-- ---------------------------------------------------------------------------------------------
-- Normalization and the probability default (the stage's default, 10/25/50/75/100/0, matching src/lib/domain/pipeline.ts):
--   on insert with no probability: the stage's default;
--   on update that changes the stage without changing the probability: the new stage's default.
-- A probability set explicitly always wins. closed_at and lost_reason are NOT auto-fixed: the stage-change function
-- sets them together, and the CHECKs above refuse an inconsistent row.
-- ---------------------------------------------------------------------------------------------
create or replace function private.stage_default_probability(stage text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select (case stage when 'new' then 10 when 'qualified' then 25 when 'proposal' then 50 when 'negotiation' then 75 when 'won' then 100 when 'lost' then 0 end)::smallint
$$;

create or replace function private.prepare_opportunity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := pg_catalog.btrim(new.title);
  new.description := nullif(pg_catalog.btrim(new.description), '');
  new.lost_reason := nullif(pg_catalog.btrim(new.lost_reason), '');
  if tg_op = 'INSERT' then
    if new.probability_percent is null then
      new.probability_percent := private.stage_default_probability(new.stage);
    end if;
  elsif new.stage is distinct from old.stage and new.probability_percent is not distinct from old.probability_percent then
    new.probability_percent := private.stage_default_probability(new.stage);
  end if;
  return new;
end;
$$;
revoke all on function private.stage_default_probability(text), private.prepare_opportunity() from public, anon, authenticated;

create trigger opportunities_prepare before insert or update on public.opportunities
  for each row execute function private.prepare_opportunity();
create trigger opportunities_set_updated_at before update on public.opportunities
  for each row execute function private.set_updated_at();
select private.protect_columns('public.opportunities', 'id', 'organization_id', 'created_by', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- Access: exactly the customers pattern (members read; owner, admin and member write while the workspace is
-- writable; viewers read only; no DELETE; the creator is the caller).
-- ---------------------------------------------------------------------------------------------
select private.attach_tenant_rls('public.opportunities');
drop policy opportunities_delete_writer on public.opportunities;
revoke delete on table public.opportunities from authenticated;
create policy opportunities_insert_creator on public.opportunities
  as restrictive for insert to authenticated
  with check (created_by is not distinct from auth.uid());

select private.attach_demo_cap('public.opportunities', 'demo_cap_opportunities');
select private.attach_activity_log(
  'public.opportunities', 'opportunity', 'title',
  array['title', 'customer_id', 'stage', 'amount_cents', 'probability_percent', 'expected_close_date', 'assigned_to'],
  array['description', 'lost_reason'],
  'archived_at'
);

-- ---------------------------------------------------------------------------------------------
-- Demo seed: exactly 10 opportunities per workspace, spread across the stages and coherent with the seeded customers
-- (each belongs to one of the first ten active customers by name): 2 new, 2 qualified, 2 proposal, 1 negotiation,
-- 2 won, 1 lost (with a reason). Fictional titles; amounts and dates plausible and relative to today.
-- ---------------------------------------------------------------------------------------------
create or replace function private.seed_opportunities(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  customer_ids uuid[];
  titles text[] := array[
    'Warehouse retrofit', 'Boiler replacement', 'Roof inspection contract', 'Seasonal maintenance plan', 'Kitchen rewiring',
    'Office tile and flooring', 'Garage door upgrade', 'Pool service agreement', 'Gutter replacement', 'Insulation upgrade'
  ];
  stages text[] := array['new', 'new', 'qualified', 'qualified', 'proposal', 'proposal', 'negotiation', 'won', 'won', 'lost'];
  amounts bigint[] := array[250000, 480000, 1250000, 620000, 3400000, 1890000, 5200000, 2750000, 940000, 1600000];
  i integer;
  closed boolean;
begin
  select m.user_id into owner_id from public.memberships m where m.organization_id = org_id and m.role = 'owner' order by m.user_id limit 1;
  select array_agg(c.id order by c.display_name) into customer_ids
    from (select id, display_name from public.customers where organization_id = org_id and archived_at is null order by display_name limit 10) c;
  for i in 1..10 loop
    closed := stages[i] in ('won', 'lost');
    insert into public.opportunities (
      organization_id, customer_id, title, description, stage, amount_cents, expected_close_date, assigned_to,
      lost_reason, closed_at, created_by, created_at, updated_at
    ) values (
      org_id, customer_ids[i], titles[i],
      case when i % 2 = 1 then 'Scope agreed on site; waiting on final measurements.' else null end,
      stages[i], amounts[i],
      case when closed then null else (pg_catalog.date_trunc('day', pg_catalog.now()) + pg_catalog.make_interval(days => 7 + i * 6))::date end,
      case when i % 3 = 1 then owner_id else null end,
      case when stages[i] = 'lost' then 'Chose a lower quote from another contractor.' else null end,
      case when closed then private.demo_ts(10 + i, 15) else null end,
      null,
      private.demo_ts(80 - (i * 6), 10),
      private.demo_ts(greatest(1, 40 - (i * 3)), 16)
    );
  end loop;
end;
$$;
create or replace function private.clear_opportunities(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.opportunities where organization_id = org_id;
end;
$$;
revoke all on function private.seed_opportunities(uuid), private.clear_opportunities(uuid) from public, anon, authenticated;
-- Position 20: after the customers they reference (cleared first on reset, seeded second).
select private.register_demo_seeder('opportunities', 20, 'private.seed_opportunities(uuid)'::regprocedure, 1, 'private.clear_opportunities(uuid)'::regprocedure);
