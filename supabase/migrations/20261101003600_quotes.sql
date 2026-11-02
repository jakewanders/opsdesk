-- SIT-222: quotes, quote_items and quote_sequences (PRD 6.2, 6.4, US-08).
-- Money is whole cents (bigint) and every total is derived with the shared formula (src/lib/domain/quotes.ts):
--   taxable = subtotal - discount;  tax = floor((taxable * tax_rate_bps + 5000) / 10000)  (half up);  total = taxable + tax.
-- CLIENTS DO NOT WRITE THESE TABLES. `authenticated` has SELECT only (members read); every insert and update goes through
-- the quote functions (SIT-230), which recompute the totals and allocate the number inside one transaction. The checks
-- below still hold for any writer, including those functions: a total that does not follow the formula, a subtotal that is
-- not the sum of the lines, a change to a sent quote, and an item for another organization's quote are all refused.

-- ---------------------------------------------------------------------------------------------
-- quotes
-- ---------------------------------------------------------------------------------------------
create table public.quotes (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  customer_id uuid not null,
  opportunity_id uuid,
  quote_number text not null,
  title text not null,
  currency text not null default 'USD',
  status text not null default 'draft',
  issue_date date not null default current_date,
  valid_until date,
  tax_rate_bps integer not null default 0,
  discount_cents bigint not null default 0,
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  notes text,
  version integer not null default 1,
  revises_quote_id uuid,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint quotes_pkey primary key (id),
  constraint quotes_org_id_key unique (organization_id, id),
  constraint quotes_org_number_key unique (organization_id, quote_number),
  constraint quotes_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint quotes_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  -- Same-organization references. A customer or deal with quotes is never deleted (they are archived), so history stays whole;
  -- removing a whole organization removes everything in one statement.
  constraint quotes_customer_fkey foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint quotes_opportunity_fkey foreign key (organization_id, opportunity_id) references public.opportunities (organization_id, id),
  constraint quotes_revises_fkey foreign key (organization_id, revises_quote_id) references public.quotes (organization_id, id),
  constraint quotes_number_format check (quote_number ~ '^Q-[0-9]{6,}$'),
  constraint quotes_title_length check (pg_catalog.char_length(pg_catalog.btrim(title)) between 2 and 150),
  constraint quotes_currency_usd check (currency = 'USD'),
  constraint quotes_status_values check (status in ('draft', 'sent', 'approved', 'rejected', 'expired')),
  constraint quotes_valid_until_after_issue check (valid_until is null or valid_until >= issue_date),
  constraint quotes_tax_rate_range check (tax_rate_bps between 0 and 10000),
  -- the same ceiling as the calculation module: the largest whole number a JavaScript client can hold exactly
  constraint quotes_money_range check (
    discount_cents between 0 and 9007199254740991 and subtotal_cents between 0 and 9007199254740991
    and tax_cents between 0 and 9007199254740991 and total_cents between 0 and 9007199254740991
  ),
  constraint quotes_discount_within_subtotal check (discount_cents <= subtotal_cents),
  -- The formula, enforced on every row (numeric arithmetic, so a large subtotal times 10,000 cannot overflow bigint).
  constraint quotes_tax_matches_formula check (
    tax_cents = pg_catalog.div(((subtotal_cents - discount_cents)::numeric * tax_rate_bps + 5000), 10000)
  ),
  constraint quotes_total_matches_formula check (total_cents = subtotal_cents - discount_cents + tax_cents),
  constraint quotes_notes_length check (notes is null or pg_catalog.char_length(notes) <= 5000),
  constraint quotes_version_positive check (version >= 1),
  constraint quotes_not_its_own_revision check (revises_quote_id is null or revises_quote_id <> id)
);

create index quotes_org_customer_idx on public.quotes (organization_id, customer_id);
create index quotes_org_status_archived_idx on public.quotes (organization_id, status, archived_at);
create index quotes_org_archived_updated_idx on public.quotes (organization_id, archived_at, updated_at desc);
create index quotes_org_opportunity_idx on public.quotes (organization_id, opportunity_id) where opportunity_id is not null;

comment on table public.quotes is 'Quotes with integer-cent totals. Written only by the quote functions; sent quotes are immutable except for their status, archive flag and version.';

-- ---------------------------------------------------------------------------------------------
-- quote_items and quote_sequences
-- ---------------------------------------------------------------------------------------------
create table public.quote_items (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  quote_id uuid not null,
  position integer not null,
  description text not null,
  quantity integer not null,
  unit_price_cents bigint not null,
  constraint quote_items_pkey primary key (id),
  constraint quote_items_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  -- the parent's organization IS this row's organization: an item cannot point at another tenant's quote
  constraint quote_items_quote_fkey foreign key (organization_id, quote_id) references public.quotes (organization_id, id) on delete cascade,
  constraint quote_items_quote_position_key unique (quote_id, position),
  constraint quote_items_position_positive check (position >= 1),
  constraint quote_items_description_length check (pg_catalog.char_length(pg_catalog.btrim(description)) between 2 and 300),
  constraint quote_items_quantity_range check (quantity between 1 and 100000),
  constraint quote_items_unit_price_range check (unit_price_cents between 0 and 100000000)
);
create index quote_items_org_quote_idx on public.quote_items (organization_id, quote_id);

create table public.quote_sequences (
  organization_id uuid not null,
  next_number bigint not null default 1,
  constraint quote_sequences_pkey primary key (organization_id),
  constraint quote_sequences_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint quote_sequences_next_positive check (next_number >= 1)
);
comment on table public.quote_sequences is 'The next quote number per organization. Allocated under a row lock by the quote functions; no API role can read or write it.';

-- ---------------------------------------------------------------------------------------------
-- Triggers.
-- All of them run as the calling role (SECURITY INVOKER) except the one deferred check that must see every line, so none of
-- them calls a private function (the SIT-217 lesson: a trigger that needs a privilege the caller lacks fails on first use).
-- ---------------------------------------------------------------------------------------------
create or replace function private.prepare_quote()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := pg_catalog.btrim(new.title);
  new.notes := nullif(pg_catalog.btrim(new.notes), '');
  return new;
end;
$$;

-- A quote leaves "draft" once, forward only: draft -> sent -> approved | rejected | expired. After it is sent, its content (what the
-- customer was shown) can never change: only the status, the archive flag, the version and the update time may. A correction is
-- a new draft (a revision), never an edit.
create or replace function private.guard_quote_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status = 'sent')
         or (old.status = 'sent' and new.status in ('approved', 'rejected', 'expired'))) then
      raise exception using errcode = 'OD409', message = pg_catalog.format('A quote that is %s cannot become %s.', old.status, new.status), detail = 'QUOTE_STATUS_TRANSITION';
    end if;
  end if;
  if old.status <> 'draft' and (
       new.customer_id is distinct from old.customer_id or new.opportunity_id is distinct from old.opportunity_id
    or new.title is distinct from old.title or new.currency is distinct from old.currency
    or new.issue_date is distinct from old.issue_date or new.valid_until is distinct from old.valid_until
    or new.tax_rate_bps is distinct from old.tax_rate_bps or new.discount_cents is distinct from old.discount_cents
    or new.subtotal_cents is distinct from old.subtotal_cents or new.tax_cents is distinct from old.tax_cents
    or new.total_cents is distinct from old.total_cents or new.notes is distinct from old.notes
    or new.revises_quote_id is distinct from old.revises_quote_id
  ) then
    raise exception using errcode = 'OD409', message = 'A quote that has been sent cannot be edited. Revise it to make a new draft.', detail = 'QUOTE_LOCKED';
  end if;
  return new;
end;
$$;

create or replace function private.guard_quote_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_status text;
begin
  select q.status into parent_status from public.quotes q where q.id = new.quote_id and q.organization_id = new.organization_id;
  if parent_status is not null and parent_status <> 'draft' then
    raise exception using errcode = 'OD409', message = 'A quote that has been sent cannot be edited. Revise it to make a new draft.', detail = 'QUOTE_LOCKED';
  end if;
  new.description := pg_catalog.btrim(new.description);
  return new;
end;
$$;

-- The subtotal is the sum of the lines, checked at COMMIT (the quote and its lines are written in one transaction, in any order).
-- SECURITY DEFINER so it sums every line whatever the writer's own visibility; a quote or line that no longer exists is skipped.
create or replace function private.assert_quote_subtotal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  qid uuid;
  org uuid;
  stored bigint;
  summed numeric;
begin
  if tg_table_name = 'quotes' then
    qid := new.id; org := new.organization_id;
  elsif tg_op = 'DELETE' then
    qid := old.quote_id; org := old.organization_id;
  else
    qid := new.quote_id; org := new.organization_id;
  end if;
  select q.subtotal_cents into stored from public.quotes q where q.id = qid and q.organization_id = org;
  if not found then
    return null;
  end if;
  select coalesce(pg_catalog.sum(i.quantity::numeric * i.unit_price_cents), 0) into summed from public.quote_items i where i.quote_id = qid;
  if summed <> stored then
    raise exception using errcode = 'OD422', message = 'The quote''s subtotal does not match its line items.', detail = 'QUOTE_SUBTOTAL_MISMATCH';
  end if;
  return null;
end;
$$;
revoke all on function private.prepare_quote(), private.guard_quote_state(), private.guard_quote_item(), private.assert_quote_subtotal() from public, anon, authenticated;

create trigger quotes_prepare before insert or update on public.quotes for each row execute function private.prepare_quote();
create trigger quotes_guard_state before update on public.quotes for each row execute function private.guard_quote_state();
create trigger quotes_set_updated_at before update on public.quotes for each row execute function private.set_updated_at();
select private.protect_columns('public.quotes', 'id', 'organization_id', 'quote_number', 'created_by', 'created_at');
create constraint trigger quotes_subtotal_matches_items after insert or update on public.quotes
  deferrable initially deferred for each row execute function private.assert_quote_subtotal();

create trigger quote_items_guard before insert or update on public.quote_items for each row execute function private.guard_quote_item();
select private.protect_columns('public.quote_items', 'id', 'organization_id', 'quote_id');
create constraint trigger quote_items_subtotal_matches after insert or update or delete on public.quote_items
  deferrable initially deferred for each row execute function private.assert_quote_subtotal();

-- ---------------------------------------------------------------------------------------------
-- Access: members read; nobody writes directly. The write policies the template adds are dropped and the privileges revoked,
-- so a client call to the Supabase SDK cannot touch a total, a number, a status or a line (it would be a permission error).
-- ---------------------------------------------------------------------------------------------
select private.attach_tenant_rls('public.quotes');
select private.attach_tenant_rls('public.quote_items');
drop policy quotes_insert_writer on public.quotes;
drop policy quotes_update_writer on public.quotes;
drop policy quotes_delete_writer on public.quotes;
drop policy quote_items_insert_writer on public.quote_items;
drop policy quote_items_update_writer on public.quote_items;
drop policy quote_items_delete_writer on public.quote_items;
revoke insert, update, delete, truncate, references, trigger on table public.quotes from authenticated;
revoke insert, update, delete, truncate, references, trigger on table public.quote_items from authenticated;
alter table public.quote_sequences enable row level security;
revoke all on table public.quote_sequences from public, anon, authenticated;

select private.attach_demo_cap('public.quotes', 'demo_cap_quotes');
select private.attach_activity_log(
  'public.quotes', 'quote', 'quote_number',
  array['title', 'customer_id', 'opportunity_id', 'status', 'issue_date', 'valid_until', 'tax_rate_bps', 'discount_cents', 'total_cents', 'version'],
  array['notes'],
  'archived_at'
);

-- ---------------------------------------------------------------------------------------------
-- Demo seed: exactly 4 quotes per workspace (2 draft, 2 sent), each for one of the first ten customers by name and, where the
-- customer has one, linked to that customer's deal. Fictional line items; totals computed with the shared formula; numbers
-- Q-000001 to Q-000004, so the next quote is Q-000005. Their history is dated from the rows themselves: a created event at
-- creation and, for the sent ones, a status update, both by the System.
-- ---------------------------------------------------------------------------------------------
create or replace function private.seed_quotes(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid;
  customer_ids uuid[];
  opp_ids uuid[];
  -- customer / deal index (1-based, in name order), title, status, discount cents, tax bps, days ago created
  specs jsonb := '[
    {"c": 2, "title": "Boiler replacement: parts and labor", "status": "draft", "discount": 0, "tax": 600, "ago": 6,
     "items": [["Replacement boiler, 120 kBTU", 1, 285000], ["Removal and disposal of old unit", 1, 45000], ["Installation labor (hours)", 14, 9500]]},
    {"c": 5, "title": "Kitchen rewiring: proposal", "status": "draft", "discount": 20000, "tax": 0, "ago": 3,
     "items": [["Rough-in wiring, per circuit", 8, 38000], ["Panel upgrade, 100 A", 1, 210000], ["Permit and inspection fee", 1, 35000]]},
    {"c": 6, "title": "Office tile and flooring", "status": "sent", "discount": 50000, "tax": 825, "ago": 21,
     "items": [["Porcelain tile, per sq ft", 1200, 650], ["Underlayment, per sq ft", 1200, 120], ["Installation, per sq ft", 1200, 480], ["Floor prep and leveling", 1, 160000]]},
    {"c": 7, "title": "Garage door upgrade", "status": "sent", "discount": 0, "tax": 825, "ago": 12,
     "items": [["Insulated sectional door, 16 x 7 ft", 2, 189900], ["Opener with battery backup", 2, 62000], ["Installation labor", 1, 90000]]}
  ]'::jsonb;
  spec jsonb;
  item jsonb;
  i integer := 0;
  q_id uuid;
  pos integer;
  subtotal bigint;
  taxable bigint;
  tax bigint;
  disc bigint;
  bps integer;
  created timestamptz;
  sent_at timestamptz;
begin
  select m.user_id into owner_id from public.memberships m where m.organization_id = org_id and m.role = 'owner' order by m.user_id limit 1;
  select pg_catalog.array_agg(c.id order by c.display_name) into customer_ids
    from (select id, display_name from public.customers where organization_id = org_id and archived_at is null order by display_name limit 10) c;
  -- the deal seeded for customer k (opportunities were seeded one per customer, in the same order)
  select pg_catalog.array_agg(o.id order by pg_catalog.array_position(customer_ids, o.customer_id)) into opp_ids
    from public.opportunities o where o.organization_id = org_id and o.customer_id = any (customer_ids);

  for spec in select * from pg_catalog.jsonb_array_elements(specs) loop
    i := i + 1;
    subtotal := 0;
    for item in select * from pg_catalog.jsonb_array_elements(spec -> 'items') loop
      subtotal := subtotal + (item ->> 1)::bigint * (item ->> 2)::bigint;
    end loop;
    disc := (spec ->> 'discount')::bigint;
    bps := (spec ->> 'tax')::integer;
    taxable := greatest(0, subtotal - disc);
    tax := pg_catalog.div(taxable::numeric * bps + 5000, 10000)::bigint;
    created := private.demo_ts((spec ->> 'ago')::integer, 11);
    sent_at := case when spec ->> 'status' = 'sent' then created + interval '2 hours' else null end;

    insert into public.quotes (
      organization_id, customer_id, opportunity_id, quote_number, title, status, issue_date, valid_until, tax_rate_bps, discount_cents,
      subtotal_cents, tax_cents, total_cents, notes, version, created_by, created_at, updated_at
    ) values (
      org_id, customer_ids[(spec ->> 'c')::integer],
      (select o.id from public.opportunities o where o.organization_id = org_id and o.customer_id = customer_ids[(spec ->> 'c')::integer] order by o.created_at limit 1),
      'Q-' || pg_catalog.lpad(i::text, 6, '0'), spec ->> 'title', 'draft',
      created::date, (created + interval '30 days')::date, bps, disc,
      subtotal, tax, taxable + tax,
      case when i % 2 = 0 then 'Valid for 30 days. Payment due on completion.' else null end,
      1, null, created, created
    ) returning id into q_id;
    pos := 0;
    for item in select * from pg_catalog.jsonb_array_elements(spec -> 'items') loop
      pos := pos + 1;
      insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents)
      values (org_id, q_id, pos, item ->> 0, (item ->> 1)::integer, (item ->> 2)::bigint);
    end loop;

    -- a sent quote is a draft that was sent: the lines go in first, then the one allowed transition (a sent quote takes no new lines)
    if sent_at is not null then
      update public.quotes set status = 'sent', version = 2 where id = q_id;
    end if;

    -- history dated from the row, in the live format (replaces the events the inserts and the update just logged)
    delete from public.activity_events e where e.organization_id = org_id and e.entity_id = q_id;
    perform pg_catalog.set_config('opsdesk.actor_mode', 'system', true);
    perform private.log_activity(org_id, 'quote', q_id, 'created', pg_catalog.format('System created quote "%s"', 'Q-' || pg_catalog.lpad(i::text, 6, '0')), '{}'::jsonb, created);
    if sent_at is not null then
      perform private.log_activity(org_id, 'quote', q_id, 'updated',
        pg_catalog.format('System updated quote "%s" (status, version)', 'Q-' || pg_catalog.lpad(i::text, 6, '0')),
        pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('old', 'draft', 'new', 'sent'), 'version', pg_catalog.jsonb_build_object('old', 1, 'new', 2)),
        sent_at);
    end if;
  end loop;
  insert into public.quote_sequences (organization_id, next_number) values (org_id, 5)
    on conflict (organization_id) do update set next_number = excluded.next_number;
end;
$$;

create or replace function private.clear_quotes(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.quotes where organization_id = org_id;
  delete from public.quote_sequences where organization_id = org_id;
end;
$$;
revoke all on function private.seed_quotes(uuid), private.clear_quotes(uuid) from public, anon, authenticated;
-- Position 40: after the customers and deals they reference, and before the activity history (990).
select private.register_demo_seeder('quotes', 40, 'private.seed_quotes(uuid)'::regprocedure, 1, 'private.clear_quotes(uuid)'::regprocedure);
