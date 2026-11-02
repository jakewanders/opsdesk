-- SIT-230: every quote write, in the database (PRD 6.5, US-08). Clients cannot write the quote tables (SIT-222); these four functions
-- are the only way a quote, a line, a total, a number or a status changes. They run as the table owner (SECURITY DEFINER, search_path
-- pinned, EXECUTE for `authenticated` only) and check everything themselves, because the table rules no longer stand between the
-- caller and the row:
--   create_quote_with_items   a new draft: validated lines, totals recomputed here, the next number taken under a row lock
--   update_draft_quote        replaces a draft's content and lines at an expected version (stale = 409), version + 1
--   transition_quote          draft -> sent, sent -> approved | rejected | expired, at an expected version
--   revise_quote              a sent (or later) quote copied into a NEW draft that points back at it; the original is never touched
-- No total, subtotal, tax, number or status is a parameter of create or update: the caller sends lines, a discount and a tax rate, and the
-- database computes the rest with the shared formula (taxable = subtotal - discount; tax = half-up of taxable x rate / 10000; total = taxable + tax).
-- Errors: OD404 not found (a non-member gets the same answer), OD403 not allowed (role, expired demo), OD409 stale / locked / bad transition,
-- OD422 invalid input, OD429 demo cap.

insert into private.app_limits (key, value, note) values
  ('max_quote_items', 100, 'Most line items on one quote.');

-- ---------------------------------------------------------------------------------------------
-- Helpers (no API role can call them)
-- ---------------------------------------------------------------------------------------------
-- Who may change quotes in this workspace: a signed-in member with a writer role (owner, admin, member), in a workspace that is still writable.
create or replace function private.require_quote_writer(p_org_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to continue.', detail = 'NOT_SIGNED_IN';
  end if;
  if p_org_id is null or not private.is_member(p_org_id) then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  if not private.has_role(p_org_id, array['owner', 'admin', 'member']) then
    raise exception using errcode = 'OD403', message = 'Your role cannot change quotes.', detail = 'FORBIDDEN';
  end if;
  if not private.org_is_writable(p_org_id) then
    raise exception using errcode = 'OD403', message = 'This demo has expired. Start a new one to keep exploring.', detail = 'DEMO_EXPIRED';
  end if;
  return uid;
end;
$$;

-- The lines and the sums, validated and computed in one place. Whole numbers only (no float anywhere), the same limits as the calculation
-- module, and a result beyond the largest exactly-representable JavaScript integer is refused rather than rounded.
create or replace function private.quote_totals(
  p_items jsonb, p_discount_cents bigint, p_tax_rate_bps integer,
  out subtotal_cents bigint, out tax_cents bigint, out total_cents bigint
)
language plpgsql
stable
set search_path = ''
as $$
declare
  max_safe constant numeric := 9007199254740991;
  limit_items integer := coalesce(private.app_limit('max_quote_items'), 100);
  item jsonb;
  n integer := 0;
  qty numeric;
  price numeric;
  sub numeric := 0;
  taxable numeric;
  tax numeric;
begin
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) = 0 then
    raise exception using errcode = 'OD422', message = 'Add at least one line item.', detail = 'ITEMS_REQUIRED';
  end if;
  if pg_catalog.jsonb_array_length(p_items) > limit_items then
    raise exception using errcode = 'OD422', message = pg_catalog.format('A quote can have at most %s line items.', limit_items), detail = 'TOO_MANY_ITEMS';
  end if;
  for item in select * from pg_catalog.jsonb_array_elements(p_items) loop
    n := n + 1;
    if pg_catalog.jsonb_typeof(item) <> 'object'
       or pg_catalog.jsonb_typeof(item -> 'description') is distinct from 'string'
       or pg_catalog.char_length(pg_catalog.btrim(item ->> 'description')) not between 2 and 300 then
      raise exception using errcode = 'OD422', message = pg_catalog.format('Line %s: describe it in 2 to 300 characters.', n), detail = 'INVALID_ITEM';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'quantity') is distinct from 'number' or (item ->> 'quantity')::numeric <> pg_catalog.trunc((item ->> 'quantity')::numeric)
       or (item ->> 'quantity')::numeric not between 1 and 100000 then
      raise exception using errcode = 'OD422', message = pg_catalog.format('Line %s: the quantity must be a whole number from 1 to 100,000.', n), detail = 'INVALID_QUANTITY';
    end if;
    if pg_catalog.jsonb_typeof(item -> 'unitPriceCents') is distinct from 'number' or (item ->> 'unitPriceCents')::numeric <> pg_catalog.trunc((item ->> 'unitPriceCents')::numeric)
       or (item ->> 'unitPriceCents')::numeric not between 0 and 100000000 then
      raise exception using errcode = 'OD422', message = pg_catalog.format('Line %s: the unit price must be a whole number of cents from 0 to 100,000,000.', n), detail = 'INVALID_PRICE';
    end if;
    qty := (item ->> 'quantity')::numeric;
    price := (item ->> 'unitPriceCents')::numeric;
    sub := sub + qty * price;
  end loop;
  if sub > max_safe then
    raise exception using errcode = 'OD422', message = 'The subtotal is too large to calculate exactly. Reduce the quantities or prices.', detail = 'QUOTE_TOO_LARGE';
  end if;
  if p_discount_cents is null or p_discount_cents < 0 then
    raise exception using errcode = 'OD422', message = 'The discount must be a whole number of cents, 0 or more.', detail = 'INVALID_DISCOUNT';
  end if;
  if p_discount_cents > sub then
    raise exception using errcode = 'OD422', message = 'The discount cannot be more than the subtotal.', detail = 'DISCOUNT_TOO_LARGE';
  end if;
  if p_tax_rate_bps is null or p_tax_rate_bps not between 0 and 10000 then
    raise exception using errcode = 'OD422', message = 'The tax rate must be from 0% to 100%.', detail = 'INVALID_TAX_RATE';
  end if;
  taxable := sub - p_discount_cents;
  tax := pg_catalog.div(taxable * p_tax_rate_bps + 5000, 10000);
  if taxable + tax > max_safe then
    raise exception using errcode = 'OD422', message = 'The total is too large to calculate exactly. Reduce the quantities or prices.', detail = 'QUOTE_TOO_LARGE';
  end if;
  subtotal_cents := sub::bigint;
  tax_cents := tax::bigint;
  total_cents := (taxable + tax)::bigint;
end;
$$;

-- The header fields every create and update validates the same way.
create or replace function private.check_quote_header(p_title text, p_valid_until date, p_issue_date date, p_notes text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_title is null or pg_catalog.char_length(pg_catalog.btrim(p_title)) not between 2 and 150 then
    raise exception using errcode = 'OD422', message = 'Give the quote a title of 2 to 150 characters.', detail = 'INVALID_TITLE';
  end if;
  if p_valid_until is not null and p_valid_until < p_issue_date then
    raise exception using errcode = 'OD422', message = 'The quote cannot be valid until a date before it is issued.', detail = 'INVALID_DATES';
  end if;
  if p_notes is not null and pg_catalog.char_length(p_notes) > 5000 then
    raise exception using errcode = 'OD422', message = 'Notes can be at most 5,000 characters.', detail = 'NOTES_TOO_LONG';
  end if;
end;
$$;

-- The customer (and optional deal) must belong to this workspace; a new quote cannot be started for an archived customer, and a deal must be
-- this customer's.
create or replace function private.check_quote_links(p_org_id uuid, p_customer_id uuid, p_opportunity_id uuid, p_keep_customer uuid default null)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  archived timestamptz;
  deal_customer uuid;
begin
  if p_customer_id is null then
    raise exception using errcode = 'OD422', message = 'Choose a customer for the quote.', detail = 'CUSTOMER_REQUIRED';
  end if;
  select c.archived_at into archived from public.customers c where c.id = p_customer_id and c.organization_id = p_org_id;
  if not found then
    raise exception using errcode = 'OD422', message = 'That customer was not found in this workspace.', detail = 'CUSTOMER_NOT_FOUND';
  end if;
  if archived is not null and p_customer_id is distinct from p_keep_customer then
    raise exception using errcode = 'OD422', message = 'That customer is archived. Restore the customer to quote them.', detail = 'CUSTOMER_ARCHIVED';
  end if;
  if p_opportunity_id is not null then
    select o.customer_id into deal_customer from public.opportunities o where o.id = p_opportunity_id and o.organization_id = p_org_id;
    if not found then
      raise exception using errcode = 'OD422', message = 'That opportunity was not found in this workspace.', detail = 'OPPORTUNITY_NOT_FOUND';
    end if;
    if deal_customer <> p_customer_id then
      raise exception using errcode = 'OD422', message = 'That opportunity belongs to a different customer.', detail = 'OPPORTUNITY_MISMATCH';
    end if;
  end if;
end;
$$;

-- The next number, taken under a row lock on the workspace's counter: concurrent callers queue, so numbers are unique and sequential; the
-- counter moves in the caller's transaction, so a failed create gives its number back (no gap).
create or replace function private.next_quote_number(p_org_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint;
begin
  insert into public.quote_sequences (organization_id, next_number) values (p_org_id, 1) on conflict (organization_id) do nothing;
  select s.next_number into n from public.quote_sequences s where s.organization_id = p_org_id for update;
  update public.quote_sequences s set next_number = n + 1 where s.organization_id = p_org_id;
  return 'Q-' || pg_catalog.lpad(n::text, 6, '0');
end;
$$;

-- The workspace's own "today" (the issue date default).
create or replace function private.org_today(p_org_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (pg_catalog.now() at time zone o.timezone)::date from public.organizations o where o.id = p_org_id
$$;

create or replace function private.insert_quote_items(p_org_id uuid, p_quote_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents)
  select p_org_id, p_quote_id, e.ord::integer, pg_catalog.btrim(e.item ->> 'description'), (e.item ->> 'quantity')::integer, (e.item ->> 'unitPriceCents')::bigint
    from pg_catalog.jsonb_array_elements(p_items) with ordinality as e(item, ord);
end;
$$;

revoke all on function
  private.require_quote_writer(uuid), private.quote_totals(jsonb, bigint, integer), private.check_quote_header(text, date, date, text),
  private.check_quote_links(uuid, uuid, uuid, uuid), private.next_quote_number(uuid), private.org_today(uuid), private.insert_quote_items(uuid, uuid, jsonb)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- create_quote_with_items
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_quote_with_items(
  p_org_id uuid, p_customer_id uuid, p_opportunity_id uuid, p_title text, p_issue_date date, p_valid_until date,
  p_tax_rate_bps integer, p_discount_cents bigint, p_notes text, p_items jsonb
)
returns public.quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  totals record;
  issue date;
  result public.quotes;
begin
  perform private.require_quote_writer(p_org_id);
  issue := coalesce(p_issue_date, private.org_today(p_org_id));
  perform private.check_quote_header(p_title, p_valid_until, issue, p_notes);
  perform private.check_quote_links(p_org_id, p_customer_id, p_opportunity_id);
  select * into totals from private.quote_totals(p_items, p_discount_cents, p_tax_rate_bps);

  -- the number is taken last, after every check, so a refused create never touches the counter (a later failure still rolls it back)
  insert into public.quotes (
    organization_id, customer_id, opportunity_id, quote_number, title, issue_date, valid_until, tax_rate_bps, discount_cents,
    subtotal_cents, tax_cents, total_cents, notes
  ) values (
    p_org_id, p_customer_id, p_opportunity_id, private.next_quote_number(p_org_id), p_title, issue, p_valid_until, p_tax_rate_bps, p_discount_cents,
    totals.subtotal_cents, totals.tax_cents, totals.total_cents, p_notes
  ) returning * into result;
  perform private.insert_quote_items(p_org_id, result.id, p_items);
  return result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- update_draft_quote: replaces the draft's header, discount, rate and lines (the caller sends the whole intended content; the API merges a
-- partial edit onto the current quote) at the version the caller last saw.
-- ---------------------------------------------------------------------------------------------
create or replace function public.update_draft_quote(
  p_id uuid, p_expected_version integer, p_customer_id uuid, p_opportunity_id uuid, p_title text, p_issue_date date, p_valid_until date,
  p_tax_rate_bps integer, p_discount_cents bigint, p_notes text, p_items jsonb
)
returns public.quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.quotes;
  totals record;
  result public.quotes;
begin
  select q.* into current_row from public.quotes q where q.id = p_id for update;
  if not found or not private.is_member(current_row.organization_id) then
    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';
  end if;
  perform private.require_quote_writer(current_row.organization_id);
  if current_row.status <> 'draft' then
    raise exception using errcode = 'OD409', message = 'A quote that has been sent cannot be edited. Revise it to make a new draft.', detail = 'QUOTE_LOCKED';
  end if;
  if p_expected_version is distinct from current_row.version then
    raise exception using errcode = 'OD409', message = 'This quote was changed by someone else since you opened it. Reload to see the latest version, then try again.', detail = 'STALE_EDIT';
  end if;
  perform private.check_quote_header(p_title, p_valid_until, coalesce(p_issue_date, current_row.issue_date), p_notes);
  perform private.check_quote_links(current_row.organization_id, p_customer_id, p_opportunity_id, current_row.customer_id);
  select * into totals from private.quote_totals(p_items, p_discount_cents, p_tax_rate_bps);

  delete from public.quote_items i where i.quote_id = p_id;
  update public.quotes q set
    customer_id = p_customer_id, opportunity_id = p_opportunity_id, title = p_title,
    issue_date = coalesce(p_issue_date, q.issue_date), valid_until = p_valid_until,
    tax_rate_bps = p_tax_rate_bps, discount_cents = p_discount_cents,
    subtotal_cents = totals.subtotal_cents, tax_cents = totals.tax_cents, total_cents = totals.total_cents,
    notes = p_notes, version = q.version + 1
  where q.id = p_id
  returning q.* into result;
  perform private.insert_quote_items(current_row.organization_id, p_id, p_items);
  return result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- transition_quote: draft -> sent; sent -> approved | rejected | expired. Sending needs at least one line. In a demo workspace "sent" only
-- changes the status: nothing is ever delivered anywhere (PRD 8.2).
-- ---------------------------------------------------------------------------------------------
create or replace function public.transition_quote(p_id uuid, p_expected_version integer, p_to_status text)
returns public.quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.quotes;
  lines integer;
  result public.quotes;
begin
  select q.* into current_row from public.quotes q where q.id = p_id for update;
  if not found or not private.is_member(current_row.organization_id) then
    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';
  end if;
  perform private.require_quote_writer(current_row.organization_id);
  if p_to_status is null or p_to_status not in ('sent', 'approved', 'rejected', 'expired') then
    raise exception using errcode = 'OD422', message = 'Choose sent, approved, rejected or expired.', detail = 'INVALID_STATUS';
  end if;
  if p_expected_version is distinct from current_row.version then
    raise exception using errcode = 'OD409', message = 'This quote was changed by someone else since you opened it. Reload to see the latest version, then try again.', detail = 'STALE_EDIT';
  end if;
  if not ((current_row.status = 'draft' and p_to_status = 'sent') or (current_row.status = 'sent' and p_to_status in ('approved', 'rejected', 'expired'))) then
    raise exception using errcode = 'OD409', message = pg_catalog.format('A quote that is %s cannot become %s.', current_row.status, p_to_status), detail = 'QUOTE_STATUS_TRANSITION';
  end if;
  if p_to_status = 'sent' then
    select pg_catalog.count(*) into lines from public.quote_items i where i.quote_id = p_id;
    if lines = 0 then
      raise exception using errcode = 'OD422', message = 'Add at least one line item before sending.', detail = 'ITEMS_REQUIRED';
    end if;
  end if;
  update public.quotes q set status = p_to_status, version = q.version + 1 where q.id = p_id returning q.* into result;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- revise_quote: the original stays exactly as it is (it is row-locked, not written, so two concurrent revisions cannot both start); a new draft (next number, version 1) carries its content and lines and points back through
-- revises_quote_id. Only a quote that has left draft can be revised, and one open draft revision per quote is enough.
-- ---------------------------------------------------------------------------------------------
create or replace function public.revise_quote(p_id uuid)
returns public.quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  source public.quotes;
  result public.quotes;
begin
  select q.* into source from public.quotes q where q.id = p_id for update;
  if not found or not private.is_member(source.organization_id) then
    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';
  end if;
  perform private.require_quote_writer(source.organization_id);
  if source.status = 'draft' then
    raise exception using errcode = 'OD409', message = 'A draft can be edited directly. Only a quote that has been sent can be revised.', detail = 'QUOTE_NOT_REVISABLE';
  end if;
  if exists (select 1 from public.quotes r where r.organization_id = source.organization_id and r.revises_quote_id = p_id and r.status = 'draft' and r.archived_at is null) then
    raise exception using errcode = 'OD409', message = 'This quote already has a draft revision. Continue editing that one.', detail = 'REVISION_EXISTS';
  end if;
  perform private.check_quote_links(source.organization_id, source.customer_id, source.opportunity_id, source.customer_id);

  insert into public.quotes (
    organization_id, customer_id, opportunity_id, quote_number, title, issue_date, valid_until, tax_rate_bps, discount_cents,
    subtotal_cents, tax_cents, total_cents, notes, revises_quote_id
  ) values (
    source.organization_id, source.customer_id, source.opportunity_id, private.next_quote_number(source.organization_id), source.title,
    private.org_today(source.organization_id), null, source.tax_rate_bps, source.discount_cents,
    source.subtotal_cents, source.tax_cents, source.total_cents, source.notes, source.id
  ) returning * into result;
  insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents)
  select i.organization_id, result.id, i.position, i.description, i.quantity, i.unit_price_cents from public.quote_items i where i.quote_id = source.id;
  return result;
end;
$$;

revoke all on function
  public.create_quote_with_items(uuid, uuid, uuid, text, date, date, integer, bigint, text, jsonb),
  public.update_draft_quote(uuid, integer, uuid, uuid, text, date, date, integer, bigint, text, jsonb),
  public.transition_quote(uuid, integer, text),
  public.revise_quote(uuid)
from public, anon;
grant execute on function
  public.create_quote_with_items(uuid, uuid, uuid, text, date, date, integer, bigint, text, jsonb),
  public.update_draft_quote(uuid, integer, uuid, uuid, text, date, date, integer, bigint, text, jsonb),
  public.transition_quote(uuid, integer, text),
  public.revise_quote(uuid)
to authenticated;
