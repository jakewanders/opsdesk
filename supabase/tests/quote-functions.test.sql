-- pgTAP tests for create_quote_with_items, update_draft_quote, transition_quote and revise_quote (SIT-230, PRD 6.5, US-08): who may call
-- them, totals computed in the database, numbering, validation, stale edits, locked quotes, revisions, rollback, and activity.
begin;
select plan(114);
select tests.create_fixtures();
insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer'),
  ('c1000000-0000-4000-8000-0000000000a2', tests.org_id('a'), 'Second Customer'),
  ('c1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'Globex Customer'),
  ('c1000000-0000-4000-8000-0000000000c1', tests.org_id('g1'), 'Demo Customer'),
  ('c1000000-0000-4000-8000-0000000000d1', tests.org_id('expired'), 'Expired Demo Customer');
insert into public.customers (id, organization_id, display_name, archived_at) values ('c1000000-0000-4000-8000-0000000000a9', tests.org_id('a'), 'Archived Customer', now());
insert into public.opportunities (id, organization_id, customer_id, title) values
  ('d1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Acme Deal'),
  ('d1000000-0000-4000-8000-0000000000a2', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a2', 'Second Deal'),
  ('d1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'c1000000-0000-4000-8000-0000000000b1', 'Globex Deal');
update public.profiles set display_name = 'Olive Owner' where id = tests.uid('a_owner');

create function pg_temp.items(n integer default 1) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('description', 'Line ' || i, 'quantity', 1, 'unitPriceCents', 100)), '[]'::jsonb) from generate_series(1, n) i
$$;
-- create as `who` with the common defaults: (who, org, customer, title, items, discount, bps)
create function pg_temp.mk(who text, org text, cust uuid, title text, items jsonb, disc bigint default 0, bps integer default 0) returns text language plpgsql as $$
declare r public.quotes;
begin
  perform tests.act_as(who);
  select * into r from public.create_quote_with_items(tests.org_id(org), cust, null, title, null, null, bps, disc, null, items);
  perform tests.reset();
  return r.id::text;
end $$;
create function pg_temp.err(who text, stmt text) returns text language plpgsql as $$
declare s text;
begin
  perform tests.act_as(who);
  s := tests.sqlstate_of(stmt);
  perform tests.reset();
  return s;
end $$;
create function pg_temp.detail(who text, stmt text) returns text language plpgsql as $$
declare d text;
begin
  perform tests.act_as(who);
  begin
    execute stmt;
    d := 'no error';
  exception when others then
    get stacked diagnostics d = pg_exception_detail;
  end;
  perform tests.reset();
  return d;
end $$;
grant execute on all functions in schema pg_temp to public;

-- ---- shape and privileges
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('create_quote_with_items', 'update_draft_quote', 'transition_quote', 'revise_quote')), 4::bigint, 'the four functions exist');
select is((select count(*) from pg_proc p where pronamespace = 'public'::regnamespace and proname in ('create_quote_with_items', 'update_draft_quote', 'transition_quote', 'revise_quote') and prosecdef and 'search_path=""' = any (coalesce(proconfig, '{}'))), 4::bigint, 'all are SECURITY DEFINER with a pinned empty search_path');
select is((select count(*) from pg_proc p where pronamespace = 'public'::regnamespace and proname in ('create_quote_with_items', 'update_draft_quote', 'transition_quote', 'revise_quote') and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')), 4::bigint, 'EXECUTE for authenticated only');
select is((select count(*) from pg_proc p, unnest(p.proargnames) a where pronamespace = 'public'::regnamespace and proname in ('create_quote_with_items', 'update_draft_quote') and a ~ 'total|subtotal|tax_cents|number|status'), 0::bigint, 'no total, tax amount, number or status is a parameter of create or update');
select is((select count(*) from pg_proc p, unnest(p.proargnames) a where pronamespace = 'public'::regnamespace and proname in ('create_quote_with_items', 'update_draft_quote', 'transition_quote', 'revise_quote') and a ~ 'actor|user|created_by'), 0::bigint, 'nor an actor: the caller is always auth.uid()');
select ok(not has_function_privilege('authenticated', 'private.next_quote_number(uuid)', 'execute') and not has_function_privilege('authenticated', 'private.quote_totals(jsonb, bigint, integer)', 'execute') and not has_function_privilege('authenticated', 'private.require_quote_writer(uuid)', 'execute'), 'the helpers are not callable by clients');
select tests.act_as_anon();
select is(tests.sqlstate_of(format($$select public.create_quote_with_items(%L, %L, null, 'T', null, null, 0, 0, null, '[]'::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1')), '42501', 'anon cannot call create');
select tests.reset();

-- no identity at all (the authenticated role with no claims) is told to sign in
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select throws_ok(format($$select public.create_quote_with_items(%L, %L, null, 'T', null, null, 0, 0, null, '[]'::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1'), 'OD403', 'Sign in to continue.', 'a call with no identity is told to sign in');
select tests.reset();

-- ---- create: totals, numbering, lines
select tests.act_as('a_owner');
select lives_ok(format($$select public.create_quote_with_items(%L, %L, null, '  First quote ', '2026-11-02', '2026-12-02', 825, 500, 'Net 30', '[{"description":"Widget","quantity":2,"unitPriceCents":1999},{"description":"  Gadget ","quantity":1,"unitPriceCents":5000}]'::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1'), 'an owner creates a quote');
select tests.reset();
select is((select quote_number || '|' || title || '|' || status || '|' || version || '|' || issue_date || '|' || subtotal_cents || '|' || tax_cents || '|' || total_cents from public.quotes where organization_id = tests.org_id('a')), 'Q-000001|First quote|draft|1|2026-11-02|8998|701|9199', 'numbered Q-000001, trimmed title, draft, version 1, totals computed from the lines (8998 - 500 = 8498; tax 701; total 9199)');
select is((select string_agg(position || ':' || description || ':' || quantity || ':' || unit_price_cents, ',' order by position) from public.quote_items where quote_id = (select id from public.quotes where organization_id = tests.org_id('a'))), '1:Widget:2:1999,2:Gadget:1:5000', 'the lines are stored in order, trimmed');
select is((select created_by from public.quotes where organization_id = tests.org_id('a')), tests.uid('a_owner'), 'created_by is the caller');
select is((select next_number from public.quote_sequences where organization_id = tests.org_id('a')), 2::bigint, 'the counter moved to 2');
select is(pg_temp.mk('a_admin', 'a', 'c1000000-0000-4000-8000-0000000000a1', 'By admin', pg_temp.items(1)) is not null, true, 'an admin can create');
select is(pg_temp.mk('a_member', 'a', 'c1000000-0000-4000-8000-0000000000a2', 'By member', pg_temp.items(1)) is not null, true, 'a member can create');
select is((select string_agg(quote_number, ',' order by quote_number) from public.quotes where organization_id = tests.org_id('a')), 'Q-000001,Q-000002,Q-000003', 'numbers are sequential');
select is(pg_temp.mk('b_owner', 'b', 'c1000000-0000-4000-8000-0000000000b1', 'Other workspace', pg_temp.items(1)) is not null, true, 'another workspace');
select is((select quote_number from public.quotes where organization_id = tests.org_id('b')), 'Q-000001', 'numbers every workspace from Q-000001 on its own');
select is((select issue_date from public.quotes where title = 'By admin'), (now() at time zone (select timezone from public.organizations where id = tests.org_id('a')))::date, 'the issue date defaults to the workspace''s own today');
select is((select count(*) from public.activity_events where entity_type = 'quote' and entity_id = (select id from public.quotes where title = 'First quote') and action = 'created'), 1::bigint, 'one created event');
select is((select summary from public.activity_events where entity_type = 'quote' and entity_id = (select id from public.quotes where title = 'First quote')), 'Olive Owner created quote "Q-000001"', 'by the person who did it');
select is(pg_temp.err('a_viewer', format($$select public.create_quote_with_items(%L, %L, null, 'Nope', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD403', 'a viewer cannot create');
select is(pg_temp.err('outsider', format($$select public.create_quote_with_items(%L, %L, null, 'Nope', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD404', 'a non-member gets "not found"');
select is(pg_temp.err('b_owner', format($$select public.create_quote_with_items(%L, %L, null, 'Nope', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD404', 'so does another workspace''s owner');
select is(pg_temp.err('g1', format($$select public.create_quote_with_items(%L, %L, null, 'Nope', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD404', 'a demo guest cannot reach a real workspace');
select is(pg_temp.mk('g1', 'g1', 'c1000000-0000-4000-8000-0000000000c1', 'Demo quote', pg_temp.items(1)) is not null, true, 'a demo guest can create in their own demo');
select is(pg_temp.err('g3', format($$select public.create_quote_with_items(%L, %L, null, 'Late', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('expired'), 'c1000000-0000-4000-8000-0000000000d1', pg_temp.items(1))), 'OD403', 'an expired demo refuses (403)');
select is(pg_temp.detail('g3', format($$select public.create_quote_with_items(%L, %L, null, 'Late', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('expired'), 'c1000000-0000-4000-8000-0000000000d1', pg_temp.items(1))), 'DEMO_EXPIRED', 'with the expiry code');

-- ---- create: validation (each one refused with 422 and a code; nothing is written)
create function pg_temp.c(items jsonb, disc bigint default 0, bps integer default 0, title text default 'Valid title', valid_until date default null, notes text default null, cust uuid default 'c1000000-0000-4000-8000-0000000000a1', opp uuid default null) returns text language sql as $f$
  select format($$select public.create_quote_with_items(%L, %L, %L, %L, '2026-11-02', %L, %s, %s, %L, %L::jsonb)$$, tests.org_id('a'), cust, opp, title, valid_until, bps, disc, notes, items)
$f$;
grant execute on function pg_temp.c(jsonb, bigint, integer, text, date, text, uuid, uuid) to public;
select is(pg_temp.detail('a_owner', pg_temp.c('[]'::jsonb)), 'ITEMS_REQUIRED', 'no lines');
select is(pg_temp.detail('a_owner', pg_temp.c('{"a": 1}'::jsonb)), 'ITEMS_REQUIRED', 'lines that are not a list');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"x","quantity":1,"unitPriceCents":1}]'::jsonb)), 'INVALID_ITEM', 'a one-character description');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":0,"unitPriceCents":1}]'::jsonb)), 'INVALID_QUANTITY', 'quantity 0');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":1.5,"unitPriceCents":1}]'::jsonb)), 'INVALID_QUANTITY', 'a fractional quantity');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":100001,"unitPriceCents":1}]'::jsonb)), 'INVALID_QUANTITY', 'quantity over 100,000');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":"3","unitPriceCents":1}]'::jsonb)), 'INVALID_QUANTITY', 'a quantity sent as text');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":1}]'::jsonb)), 'INVALID_PRICE', 'a missing price');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":1,"unitPriceCents":-1}]'::jsonb)), 'INVALID_PRICE', 'a negative price');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":1,"unitPriceCents":100000001}]'::jsonb)), 'INVALID_PRICE', 'a price over 1,000,000.00');
select is(pg_temp.detail('a_owner', pg_temp.c('[{"description":"Widget","quantity":1,"unitPriceCents":12.5}]'::jsonb)), 'INVALID_PRICE', 'a price with a fraction of a cent');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), -1)), 'INVALID_DISCOUNT', 'a negative discount');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), 101)), 'DISCOUNT_TOO_LARGE', 'a discount larger than the subtotal');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), 0, 10001)), 'INVALID_TAX_RATE', 'a tax rate over 100%');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), 0, 0, 'x')), 'INVALID_TITLE', 'a one-character title');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), 0, 0, 'Valid title', '2026-10-01')), 'INVALID_DATES', 'valid-until before the issue date');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), 0, 0, 'Valid title', null, repeat('n', 5001))), 'NOTES_TOO_LONG', 'notes over 5,000');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), cust => 'c1000000-0000-4000-8000-0000000000b1')), 'CUSTOMER_NOT_FOUND', 'another workspace''s customer');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), cust => 'c1000000-0000-4000-8000-0000000000a9')), 'CUSTOMER_ARCHIVED', 'an archived customer');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), opp => 'd1000000-0000-4000-8000-0000000000b1')), 'OPPORTUNITY_NOT_FOUND', 'another workspace''s deal');
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(1), opp => 'd1000000-0000-4000-8000-0000000000a2')), 'OPPORTUNITY_MISMATCH', 'a deal that belongs to a different customer');
select tests.act_as('a_owner');
select lives_ok(pg_temp.c(pg_temp.items(1), opp => 'd1000000-0000-4000-8000-0000000000a1'), 'a deal of the same customer is fine');
select tests.reset();
select is(pg_temp.detail('a_owner', format($$select public.create_quote_with_items(%L, null, null, 'Valid title', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('a'), pg_temp.items(1))), 'CUSTOMER_REQUIRED', 'no customer');
update private.app_limits set value = 2 where key = 'max_quote_items';
select is(pg_temp.detail('a_owner', pg_temp.c(pg_temp.items(3))), 'TOO_MANY_ITEMS', 'more lines than the limit');
update private.app_limits set value = 1000 where key = 'max_quote_items';
select is(pg_temp.detail('a_owner', pg_temp.c((select jsonb_agg(jsonb_build_object('description', 'Big ' || i, 'quantity', 100000, 'unitPriceCents', 100000000)) from generate_series(1, 901) i))), 'QUOTE_TOO_LARGE', 'a subtotal beyond the exact integer range');
select is(pg_temp.detail('a_owner', pg_temp.c((select jsonb_agg(jsonb_build_object('description', 'Big ' || i, 'quantity', 100000, 'unitPriceCents', 100000000)) from generate_series(1, 901) i), 9010000000000000)), 'QUOTE_TOO_LARGE', 'a subtotal beyond the range is refused even when a discount would bring the total to zero');
select is(pg_temp.detail('a_owner', pg_temp.c((select jsonb_agg(jsonb_build_object('description', 'Big ' || i, 'quantity', 100000, 'unitPriceCents', 100000000)) from generate_series(1, 451) i), 0, 10000)), 'QUOTE_TOO_LARGE', 'a total beyond it (100% tax on 4.51 quadrillion cents)');
update private.app_limits set value = 100 where key = 'max_quote_items';
select is((select count(*) from public.quotes where organization_id = tests.org_id('a')), 4::bigint, 'after every refusal above, no quote was written (4 in A: three from the earlier cases and the valid-deal check)');
select is((select next_number from public.quote_sequences where organization_id = tests.org_id('a')), 5::bigint, 'and the counter did not move for any of them');

select is(pg_temp.detail('outsider', format($$select public.update_draft_quote((select id from public.quotes where title = 'First quote'), 1, %L, null, 'X', null, null, 0, 0, null, %L::jsonb)$$, 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'QUOTE_NOT_FOUND', 'updating a quote of a workspace you are not in says the quote was not found');
select is(pg_temp.detail('outsider', $$select public.transition_quote((select id from public.quotes where title = 'First quote'), 1, 'sent')$$), 'QUOTE_NOT_FOUND', 'so does sending it');
select is(pg_temp.detail('outsider', $$select public.revise_quote((select id from public.quotes where title = 'First quote'))$$), 'QUOTE_NOT_FOUND', 'and revising it');

-- ---- rollback: a failure after the number was taken gives the number back
update private.app_limits set value = 1 where key = 'demo_cap_quotes';
select is(pg_temp.err('g1', format($$select public.create_quote_with_items(%L, %L, null, 'Over the cap', null, null, 0, 0, null, %L::jsonb)$$, tests.org_id('g1'), 'c1000000-0000-4000-8000-0000000000c1', pg_temp.items(1))), 'OD429', 'a create past the demo cap is refused (429)');
update private.app_limits set value = 20 where key = 'demo_cap_quotes';
select is((select count(*) from public.quotes where organization_id = tests.org_id('g1')), 1::bigint, 'and nothing half-created remains (still 1 quote)');
select is((select count(*) from public.quote_items where organization_id = tests.org_id('g1')), 1::bigint, 'nor any stray line (still 1 line)');
select is((select next_number from public.quote_sequences where organization_id = tests.org_id('g1')), 2::bigint, 'and the number was not consumed: the next demo quote is Q-000002');

-- ---- update_draft_quote
select tests.act_as('a_member');
select lives_ok(format($$select public.update_draft_quote(%L, 1, %L, null, 'Renamed', null, null, 0, 1000, 'Updated', '[{"description":"New A","quantity":3,"unitPriceCents":2000},{"description":"New B","quantity":1,"unitPriceCents":500}]'::jsonb)$$, (select id from public.quotes where title = 'By admin'), 'c1000000-0000-4000-8000-0000000000a1'), 'a member updates a draft at its version');
select tests.reset();
select is((select title || '|' || version || '|' || subtotal_cents || '|' || tax_cents || '|' || total_cents || '|' || discount_cents from public.quotes where id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'Renamed|2|6500|0|5500|1000', 'recomputed: 3 x 2000 + 500 = 6500, less 1000 = 5500, version 2');
select is((select string_agg(description, ',' order by position) from public.quote_items where quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'New A,New B', 'the lines were replaced, in order');
select is((select count(*) from public.quote_items where quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 2::bigint, 'with none left over');
select is(pg_temp.detail('a_member', format($$select public.update_draft_quote(%L, 1, %L, null, 'Stale', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'STALE_EDIT', 'a stale version is a conflict');
select is((select title || version from public.quotes where (title like 'Renamed%' and revises_quote_id is null) or title = 'Stale'), 'Renamed2', 'which changed nothing');
select is(pg_temp.err('a_member', format($$select public.update_draft_quote(%L, 2, %L, null, 'Bad', null, null, 0, 99999, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD422', 'an invalid update is refused (a discount above the subtotal)');
select is((select version from public.quotes where title = 'Renamed' and revises_quote_id is null), 2, 'and the version did not move');
select is(pg_temp.err('a_viewer', format($$select public.update_draft_quote(%L, 2, %L, null, 'Viewer', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD403', 'a viewer cannot update');
select is(pg_temp.err('b_owner', format($$select public.update_draft_quote(%L, 2, %L, null, 'Cross', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD404', 'another workspace''s owner gets "not found"');
select is(pg_temp.err('a_owner', format($$select public.update_draft_quote(gen_random_uuid(), 1, %L, null, 'None', null, null, 0, 0, null, %L::jsonb)$$, 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'OD404', 'an unknown quote is not found');
update public.customers set archived_at = now() where id = 'c1000000-0000-4000-8000-0000000000a2';
select tests.act_as('a_member');
select lives_ok(format($$select public.update_draft_quote(%L, 1, 'c1000000-0000-4000-8000-0000000000a2', null, 'Kept archived customer', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'By member'), pg_temp.items(1)), 'a quote keeps its customer after that customer is archived');
select tests.reset();
select is(pg_temp.detail('a_owner', format($$select public.update_draft_quote(%L, 2, 'c1000000-0000-4000-8000-0000000000a2', null, 'Move to archived', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), pg_temp.items(1))), 'CUSTOMER_ARCHIVED', 'moving a quote to an archived customer is refused');
update public.customers set archived_at = null where id = 'c1000000-0000-4000-8000-0000000000a2';

-- ---- transition_quote
select is(pg_temp.detail('a_member', format($$select public.transition_quote(%L, 1, 'approved')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'STALE_EDIT', 'a stale version cannot transition');
select is(pg_temp.detail('a_member', format($$select public.transition_quote(%L, 2, 'approved')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'QUOTE_STATUS_TRANSITION', 'draft -> approved is refused');
select is(pg_temp.detail('a_member', format($$select public.transition_quote(%L, 2, 'paid')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'INVALID_STATUS', 'an unknown status is refused');
select is(pg_temp.err('a_viewer', format($$select public.transition_quote(%L, 2, 'sent')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'OD403', 'a viewer cannot send');
select is(pg_temp.err('outsider', format($$select public.transition_quote(%L, 2, 'sent')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'OD404', 'a non-member gets "not found"');
select tests.act_as('a_member');
select lives_ok(format($$select public.transition_quote(%L, 2, 'sent')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'draft -> sent');
select tests.reset();
select is((select status || '|' || version from public.quotes where title = 'Renamed' and revises_quote_id is null), 'sent|3', 'sent, version 3');
select is(pg_temp.detail('a_member', format($$select public.update_draft_quote(%L, 3, %L, null, 'After send', null, null, 0, 0, null, %L::jsonb)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null), 'c1000000-0000-4000-8000-0000000000a1', pg_temp.items(1))), 'QUOTE_LOCKED', 'a sent quote cannot be edited');
select is(pg_temp.detail('a_member', format($$select public.transition_quote(%L, 3, 'draft')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'INVALID_STATUS', 'there is no way back to draft through the function');
select is(pg_temp.detail('a_member', format($$select public.transition_quote(%L, 3, 'sent')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'QUOTE_STATUS_TRANSITION', 'sent -> sent is refused');
select is((select count(*) from public.activity_events where entity_type = 'quote' and entity_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null) and action = 'updated' and changes -> 'status' = '{"old": "draft", "new": "sent"}'::jsonb), 1::bigint, 'the send is logged with the old and new status');
select is((select actor_user_id from public.activity_events where entity_type = 'quote' and entity_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null) and changes -> 'status' = '{"old": "draft", "new": "sent"}'::jsonb), tests.uid('a_member'), 'by the person who sent it');
insert into public.quotes (id, organization_id, customer_id, quote_number, title) values ('a1000000-0000-4000-8000-0000000000e1', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000090', 'Empty draft');
select is(pg_temp.detail('a_owner', format($$select public.transition_quote('a1000000-0000-4000-8000-0000000000e1', 1, 'sent')$$)), 'ITEMS_REQUIRED', 'a quote with no lines cannot be sent');
select tests.act_as('a_owner');
select lives_ok(format($$select public.transition_quote(%L, 3, 'approved')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'sent -> approved');
select tests.reset();
select is(pg_temp.detail('a_owner', format($$select public.transition_quote(%L, 4, 'rejected')$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'QUOTE_STATUS_TRANSITION', 'approved is final');
select is(pg_temp.mk('g1', 'g1', 'c1000000-0000-4000-8000-0000000000c1', 'Demo to send', pg_temp.items(1)) is not null, true, 'a demo quote');
select tests.act_as('g1');
select lives_ok(format($$select public.transition_quote(%L, 1, 'sent')$$, (select id from public.quotes where title = 'Demo to send')), 'is sent in the demo: a status change only');
select tests.reset();
select is((select status from public.quotes where title = 'Demo to send'), 'sent', 'sent');

-- ---- revise_quote
create temp table before_rev as select to_jsonb(q) as quote, (select jsonb_agg(to_jsonb(i) order by i.position) from public.quote_items i where i.quote_id = q.id) as items
  from public.quotes q where q.title = 'Renamed' and q.revises_quote_id is null;
select is(pg_temp.err('a_viewer', format($$select public.revise_quote(%L)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'OD403', 'a viewer cannot revise');
select is(pg_temp.err('outsider', format($$select public.revise_quote(%L)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'OD404', 'a non-member gets "not found"');
select is(pg_temp.detail('a_member', format($$select public.revise_quote(%L)$$, (select id from public.quotes where title = 'First quote'))), 'QUOTE_NOT_REVISABLE', 'a draft cannot be revised (edit it)');
select tests.act_as('a_member');
select lives_ok(format($$select public.revise_quote(%L)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'an approved quote is revised');
select tests.reset();
select is((select count(*) from public.quotes where revises_quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 1::bigint, 'one new quote points back at it');
select is((select r.status || '|' || r.version || '|' || r.title || '|' || r.subtotal_cents || '|' || r.total_cents || '|' || r.discount_cents || '|' || coalesce(r.valid_until::text, 'null') from public.quotes r where r.revises_quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'draft|1|Renamed|6500|5500|1000|null', 'a new draft with the same content and totals, version 1, no expiry date');
select is((select r.quote_number from public.quotes r where r.revises_quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)) > (select quote_number from public.quotes where title = 'Renamed' and revises_quote_id is null), true, 'and a newer number');
select is((select string_agg(description || quantity || unit_price_cents, ',' order by position) from public.quote_items where quote_id = (select r.id from public.quotes r where r.revises_quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'New A32000,New B1500', 'the lines were copied');
select is((select to_jsonb(q) from public.quotes q where q.title = 'Renamed' and q.revises_quote_id is null), (select quote from before_rev), 'the original quote row is byte-identical');
select is((select jsonb_agg(to_jsonb(i) order by i.position) from public.quote_items i where i.quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), (select items from before_rev), 'and so are its lines');
select is(pg_temp.detail('a_member', format($$select public.revise_quote(%L)$$, (select id from public.quotes where title = 'Renamed' and revises_quote_id is null))), 'REVISION_EXISTS', 'a second revision while one draft is open is refused');
select tests.act_as('a_member');
select lives_ok(format($$select public.update_draft_quote(%L, 1, %L, null, 'Revision edited', null, null, 825, 0, null, '[{"description":"Revised line","quantity":1,"unitPriceCents":10000}]'::jsonb)$$, (select r.id from public.quotes r where r.revises_quote_id = (select id from public.quotes where title = 'Renamed' and revises_quote_id is null)), 'c1000000-0000-4000-8000-0000000000a1'), 'the revision is a normal draft: it can be edited');
select tests.reset();
select is((select total_cents from public.quotes where title = 'Revision edited'), 10825::bigint, 'with its own totals (10000 + 825 bps = 10825)');
select is((select to_jsonb(q) from public.quotes q where q.title = 'Renamed' and q.revises_quote_id is null), (select quote from before_rev), 'and the original is still untouched');
select is((select count(*) from public.activity_events where entity_type = 'quote' and action = 'created' and entity_id = (select id from public.quotes where title = 'Revision edited')), 1::bigint, 'the revision logs its own created event');

-- ---- clients still cannot write the tables directly, and every path left the data consistent
select is(tests.denied_as('a_owner', $$update public.quotes set total_cents = 1$$), true, 'a direct write to a total is still denied');
select is((select count(*) from public.quotes q where q.subtotal_cents <> (select coalesce(sum(i.quantity::numeric * i.unit_price_cents), 0) from public.quote_items i where i.quote_id = q.id)), 0::bigint, 'every quote''s subtotal equals the sum of its lines');
select is((select count(*) from public.quotes q where q.total_cents <> (q.subtotal_cents - q.discount_cents) + floor(((q.subtotal_cents - q.discount_cents)::numeric * q.tax_rate_bps + 5000) / 10000)), 0::bigint, 'and every total follows the formula');
select is((select count(distinct quote_number) from public.quotes where organization_id = tests.org_id('a')), (select count(*) from public.quotes where organization_id = tests.org_id('a')), 'numbers are unique');

select * from finish();
rollback;
