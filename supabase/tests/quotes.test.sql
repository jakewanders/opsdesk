-- pgTAP tests for public.quotes, quote_items and quote_sequences (SIT-222, PRD 6.2, 6.4, US-08): who can read and write, the money
-- formula and ranges, same-tenant references, the subtotal-equals-lines check, sent quotes being immutable, the demo cap, and activity.
-- The "writer" in most tests is the trusted role (as the quote functions will be); clients are tested separately and cannot write at all.
begin;
select plan(100);
select tests.create_fixtures();
insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer'),
  ('c1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'Globex Customer'),
  ('c1000000-0000-4000-8000-0000000000c1', tests.org_id('g1'), 'Demo Customer');
insert into public.opportunities (id, organization_id, customer_id, title) values
  ('d1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Acme Deal'),
  ('d1000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'c1000000-0000-4000-8000-0000000000b1', 'Globex Deal');

-- a helper to insert a quote whose totals follow the formula: (id, org, number, subtotal, discount, bps)
create function pg_temp.q(qid uuid, org uuid, num text, sub bigint, disc bigint, bps integer, cust uuid) returns void language plpgsql as $$
begin
  insert into public.quotes (id, organization_id, customer_id, quote_number, title, subtotal_cents, discount_cents, tax_rate_bps, tax_cents, total_cents)
  values (qid, org, cust, num, 'Quote ' || num, sub, disc, bps,
          floor(((sub - disc)::numeric * bps + 5000) / 10000)::bigint, (sub - disc) + floor(((sub - disc)::numeric * bps + 5000) / 10000)::bigint);
end $$;

-- ---- shape
select has_table('public', 'quotes', 'quotes exists');
select has_table('public', 'quote_items', 'quote_items exists');
select has_table('public', 'quote_sequences', 'quote_sequences exists');
select is((select count(*) from pg_class where oid in ('public.quotes'::regclass, 'public.quote_items'::regclass, 'public.quote_sequences'::regclass) and relrowsecurity), 3::bigint, 'row level security is on for all three');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'quotes' and grantee = 'authenticated'), 'SELECT', 'clients may only SELECT from quotes');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'quote_items' and grantee = 'authenticated'), 'SELECT', 'and from quote_items');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'quote_sequences' and grantee in ('authenticated', 'anon', 'PUBLIC')), 0::bigint, 'quote_sequences is not readable or writable by any API role');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name in ('quotes', 'quote_items') and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds nothing on quotes or quote_items');
select is((select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies where schemaname = 'public' and tablename in ('quotes', 'quote_items')), 'quote_items_select_member:SELECT,quotes_select_member:SELECT', 'the only policies are member reads');
select is((select count(*) from pg_policies where schemaname = 'public' and tablename = 'quote_sequences'), 0::bigint, 'quote_sequences has no policy (deny all)');
select is((select count(*) from pg_constraint where conrelid = 'public.quotes'::regclass and conname in ('quotes_org_id_key', 'quotes_org_number_key') and contype = 'u'), 2::bigint, 'unique (organization_id, id) and (organization_id, quote_number)');
select is((select count(*) from pg_constraint where conrelid = 'public.quote_items'::regclass and conname = 'quote_items_quote_position_key' and contype = 'u'), 1::bigint, 'unique (quote_id, position)');
select is((select array_agg(indexname::text order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'quotes' and indexname like '%\_idx'), array['quotes_org_archived_updated_idx', 'quotes_org_customer_idx', 'quotes_org_issue_date_idx', 'quotes_org_opportunity_idx', 'quotes_org_status_archived_idx', 'quotes_org_valid_until_idx'], 'the customer, status, recency, issue-date, valid-until and opportunity indexes exist');

-- ---- a quote and its lines, written by the trusted role
select lives_ok($$select pg_temp.q('a1000000-0000-4000-8000-000000000001', tests.org_id('a'), 'Q-000001', 0, 0, 825, 'c1000000-0000-4000-8000-0000000000a1')$$, 'a quote with no lines and zero totals is valid');
select is((select title || '|' || status || '|' || currency || '|' || version || '|' || tax_cents from public.quotes where id = 'a1000000-0000-4000-8000-000000000001'), 'Quote Q-000001|draft|USD|1|0', 'defaults: draft, USD, version 1');
select lives_ok($$update public.quotes set title = '  Spaced title  ', notes = '   ' where id = 'a1000000-0000-4000-8000-000000000001'$$, 'a title is trimmed and blank notes become null');
select is((select title || '|' || coalesce(notes, 'NULL') from public.quotes where id = 'a1000000-0000-4000-8000-000000000001'), 'Spaced title|NULL', 'trimmed');

-- ---- the money rules
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-12', 'Bad number')$$, '23514', null, 'a number not shaped Q- plus 6 digits is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, status) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Bad status', 'paid')$$, '23514', null, 'an unknown status is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, currency) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Euro', 'EUR')$$, '23514', null, 'only USD');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'x')$$, '23514', null, 'a one-character title is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, tax_rate_bps) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Rate', 10001)$$, '23514', null, 'a tax rate over 100% is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, discount_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Neg', -1)$$, '23514', null, 'a negative discount is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, subtotal_cents, discount_cents, total_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Big discount', 1000, 1001, 0)$$, '23514', null, 'a discount larger than the subtotal is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, subtotal_cents, total_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Wrong total', 1000, 999)$$, '23514', null, 'a total that is not taxable plus tax is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, subtotal_cents, tax_rate_bps, tax_cents, total_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000002', 'Wrong tax', 1000, 1000, 99, 1099)$$, '23514', null, 'a tax amount that is not the rounded rate times the taxable amount is refused');
select lives_ok($$select pg_temp.q('a1000000-0000-4000-8000-0000000000f2', tests.org_id('a'), 'Q-000002', 1000, 0, 1, 'c1000000-0000-4000-8000-0000000000a1')$$, 'half-up: 1000 at 0.01% is exactly 0.1, so tax rounds to 0');
select is((select tax_cents from public.quotes where quote_number = 'Q-000002' and organization_id = tests.org_id('a')), 0::bigint, 'and 1000 cents at 1 bp is 0 tax');
select lives_ok($$select pg_temp.q('a1000000-0000-4000-8000-0000000000f3', tests.org_id('a'), 'Q-000003', 5000, 0, 1, 'c1000000-0000-4000-8000-0000000000a1')$$, '5000 at 1 bp is exactly 0.5 and rounds up (half up, not to even)');
select is((select tax_cents from public.quotes where quote_number = 'Q-000003' and organization_id = tests.org_id('a')), 1::bigint, 'to 1 cent');
select lives_ok($$select pg_temp.q('a1000000-0000-4000-8000-0000000000f4', tests.org_id('a'), 'Q-000004', 4503599627370495, 0, 10000, 'c1000000-0000-4000-8000-0000000000a1')$$, 'the largest exact quote (100% tax on 4.5 quadrillion cents) fits without overflow');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, subtotal_cents, tax_rate_bps, tax_cents, total_cents) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000005', 'Too big', 4503599627370496, 10000, 4503599627370496, 9007199254740992)$$, '23514', null, 'a total beyond the exact range of a JavaScript number is refused');
delete from public.quotes where id in ('a1000000-0000-4000-8000-0000000000f2', 'a1000000-0000-4000-8000-0000000000f3', 'a1000000-0000-4000-8000-0000000000f4');
select lives_ok($$select pg_temp.q('a1000000-0000-4000-8000-000000000003', tests.org_id('a'), 'Q-000008', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000a1')$$, 'a zero-total draft for the transition tests');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, issue_date, valid_until) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000005', 'Dates', '2026-02-01', '2026-01-31')$$, '23514', null, 'valid-until before the issue date is refused');
select throws_ok($$insert into public.quotes (id, organization_id, customer_id, quote_number, title, revises_quote_id) values ('a1000000-0000-4000-8000-00000000000f', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000005', 'Self', 'a1000000-0000-4000-8000-00000000000f')$$, '23514', null, 'a quote cannot revise itself');
select throws_ok($$select pg_temp.q('a1000000-0000-4000-8000-000000000009', tests.org_id('a'), 'Q-000001', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000a1')$$, '23505', null, 'a number is unique within a workspace');
select lives_ok($$select pg_temp.q('b1000000-0000-4000-8000-000000000001', tests.org_id('b'), 'Q-000001', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000b1')$$, 'and the same number is fine in another workspace');

-- ---- same-tenant references
select throws_ok($$select pg_temp.q('a1000000-0000-4000-8000-00000000000a', tests.org_id('a'), 'Q-000006', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000b1')$$, '23503', null, 'a quote for another workspace''s customer is refused');
select throws_ok($$insert into public.quotes (organization_id, customer_id, opportunity_id, quote_number, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000b1', 'Q-000006', 'Cross deal')$$, '23503', null, 'or another workspace''s deal');
select lives_ok($$insert into public.quotes (organization_id, customer_id, opportunity_id, quote_number, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'd1000000-0000-4000-8000-0000000000a1', 'Q-000006', 'Same-workspace deal')$$, 'a deal in the same workspace is fine');
select throws_ok($$insert into public.quotes (organization_id, customer_id, quote_number, title, revises_quote_id) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000007', 'Revises other', 'b1000000-0000-4000-8000-000000000001')$$, '23503', null, 'a revision of another workspace''s quote is refused');
select throws_ok($$delete from public.customers where id = 'c1000000-0000-4000-8000-0000000000a1'$$, '23503', null, 'a customer with quotes cannot be deleted (customers are archived)');

-- ---- items
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('b'), 'a1000000-0000-4000-8000-000000000001', 1, 'Cross-tenant line', 1, 100)$$, '23503', null, 'a line pointing at another workspace''s quote is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 0, 'Line', 1, 100)$$, '23514', null, 'a position below 1 is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'x', 1, 100)$$, '23514', null, 'a one-character description is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, repeat('d', 301), 1, 100)$$, '23514', null, 'a description over 300 is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'Line', 0, 100)$$, '23514', null, 'quantity 0 is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'Line', 100001, 100)$$, '23514', null, 'quantity over 100,000 is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'Line', 1, -1)$$, '23514', null, 'a negative price is refused');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'Line', 1, 100000001)$$, '23514', null, 'a price over 1,000,000.00 is refused');

-- ---- the subtotal must be the sum of the lines (checked at commit; forced here with SET CONSTRAINTS)
insert into public.quotes (id, organization_id, customer_id, quote_number, title, subtotal_cents, total_cents)
  values ('a1000000-0000-4000-8000-0000000000c1', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000020', 'Subtotal check', 1500, 1500);
insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values
  (tests.org_id('a'), 'a1000000-0000-4000-8000-0000000000c1', 1, 'Widget', 3, 300), (tests.org_id('a'), 'a1000000-0000-4000-8000-0000000000c1', 2, 'Gadget', 1, 600);
select lives_ok($$set constraints all immediate$$, 'quote and lines written in either order are consistent when 3 x 300 + 600 = 1500');
set constraints all deferred;
update public.quote_items set quantity = 4 where quote_id = 'a1000000-0000-4000-8000-0000000000c1' and position = 1;
select throws_ok($$set constraints all immediate$$, 'OD422', 'The quote''s subtotal does not match its line items.', 'changing a line without the subtotal is refused at commit');
set constraints all deferred;
update public.quotes set subtotal_cents = 1800, total_cents = 1800 where id = 'a1000000-0000-4000-8000-0000000000c1';
select lives_ok($$set constraints all immediate$$, 'and consistent again once the subtotal follows');
set constraints all deferred;
delete from public.quote_items where quote_id = 'a1000000-0000-4000-8000-0000000000c1' and position = 2;
select throws_ok($$set constraints all immediate$$, 'OD422', null, 'deleting a line without the subtotal is refused');
set constraints all deferred;
update public.quotes set subtotal_cents = 1200, total_cents = 1200 where id = 'a1000000-0000-4000-8000-0000000000c1';
select lives_ok($$set constraints all immediate$$, 'consistent after the delete');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-0000000000c1', 1, 'Duplicate position', 1, 1)$$, '23505', null, 'a position is used once per quote');
set constraints all deferred;
insert into public.quotes (id, organization_id, customer_id, quote_number, title, subtotal_cents, total_cents) values ('a1000000-0000-4000-8000-0000000000c2', tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000021', 'No lines but a subtotal', 500, 500);
select throws_ok($$set constraints all immediate$$, 'OD422', null, 'a subtotal with no lines at all is refused');
set constraints all deferred;
delete from public.quotes where id = 'a1000000-0000-4000-8000-0000000000c2';
set constraints all immediate;

-- ---- state: forward only, and a sent quote is locked
select lives_ok($$update public.quotes set status = 'sent', version = 2 where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'draft -> sent');
select throws_ok($$update public.quotes set title = 'Changed after sending' where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', 'A quote that has been sent cannot be edited. Revise it to make a new draft.', 'a sent quote''s title cannot change');
select throws_ok($$update public.quotes set discount_cents = 100, total_cents = 1100 where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', null, 'nor its discount or totals');
select throws_ok($$update public.quotes set customer_id = 'c1000000-0000-4000-8000-0000000000a1', notes = 'x' where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', null, 'nor its notes');
select throws_ok($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-0000000000c1', 9, 'Late line', 1, 1)$$, 'OD409', null, 'a line cannot be added to a sent quote');
select throws_ok($$update public.quote_items set quantity = 9 where quote_id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', null, 'or changed');
select throws_ok($$update public.quotes set status = 'draft' where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', 'A quote that is sent cannot become draft.', 'sent -> draft is refused');
select lives_ok($$update public.quotes set archived_at = now(), version = 3 where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'a sent quote can still be archived and its version bumped');
select lives_ok($$update public.quotes set status = 'approved', version = 4 where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'sent -> approved');
select throws_ok($$update public.quotes set status = 'rejected' where id = 'a1000000-0000-4000-8000-0000000000c1'$$, 'OD409', 'A quote that is approved cannot become rejected.', 'approved is final');
select throws_ok($$update public.quotes set status = 'approved' where id = 'a1000000-0000-4000-8000-000000000001'$$, 'OD409', 'A quote that is draft cannot become approved.', 'draft -> approved skips sending and is refused');
select throws_ok($$update public.quotes set status = 'expired' where id = 'a1000000-0000-4000-8000-000000000001'$$, 'OD409', null, 'draft -> expired is refused');
select lives_ok($$update public.quotes set status = 'sent' where id = 'a1000000-0000-4000-8000-000000000003'$$, 'another draft is sent');
select lives_ok($$update public.quotes set status = 'expired' where id = 'a1000000-0000-4000-8000-000000000003'$$, 'sent -> expired');
select throws_ok($$update public.quotes set quote_number = 'Q-999999' where id = 'a1000000-0000-4000-8000-000000000001'$$, 'OD403', null, 'a quote''s number never changes');
select throws_ok($$update public.quotes set organization_id = tests.org_id('b') where id = 'a1000000-0000-4000-8000-000000000001'$$, 'OD403', null, 'nor its workspace');
select throws_ok($$update public.quote_items set quote_id = 'a1000000-0000-4000-8000-000000000001' where quote_id = 'a1000000-0000-4000-8000-0000000000c1' and position = 1$$, 'OD403', null, 'a line cannot be moved to another quote');

-- ---- activity
select is((select count(*) from public.activity_events where entity_type = 'quote' and entity_id = 'a1000000-0000-4000-8000-0000000000c1' and action = 'created'), 1::bigint, 'creating a quote logs one created event');
select is((select summary from public.activity_events where entity_type = 'quote' and entity_id = 'a1000000-0000-4000-8000-0000000000c1' and action = 'created'), 'System created quote "Q-000020"', 'named by its number');
select is((select count(*) from public.activity_events where entity_type = 'quote' and entity_id = 'a1000000-0000-4000-8000-0000000000c1' and action = 'updated' and changes -> 'status' = '{"old": "sent", "new": "approved"}'::jsonb), 1::bigint, 'a status change logs the old and new status');
select is((select count(*) from public.activity_events where entity_type = 'quote' and entity_id = 'a1000000-0000-4000-8000-0000000000c1' and action = 'archived'), 1::bigint, 'archiving is logged');
select is((select count(*) from public.activity_events where entity_type = 'quote' and changes::text like '%Widget%'), 0::bigint, 'line items are not in the activity feed');

-- ---- demo cap
update private.app_limits set value = 2 where key = 'demo_cap_quotes';
select lives_ok($$select pg_temp.q('e1000000-0000-4000-8000-000000000001', tests.org_id('g1'), 'Q-000001', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000c1')$$, 'a demo workspace can add quotes up to the cap (1)');
select lives_ok($$select pg_temp.q('e1000000-0000-4000-8000-000000000002', tests.org_id('g1'), 'Q-000002', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000c1')$$, '(2)');
select throws_ok($$select pg_temp.q('e1000000-0000-4000-8000-000000000003', tests.org_id('g1'), 'Q-000003', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000c1')$$, 'OD429', null, 'the next one past the cap is refused with the cap error');
update private.app_limits set value = 20 where key = 'demo_cap_quotes';
select cmp_ok((select count(*) from public.quotes where organization_id = tests.org_id('a')), '>=', 4::bigint, 'real workspaces are never capped (several quotes in A)');
update public.quotes set archived_at = now() where id = 'e1000000-0000-4000-8000-000000000001';
update private.app_limits set value = 2 where key = 'demo_cap_quotes';
select throws_ok($$select pg_temp.q('e1000000-0000-4000-8000-000000000004', tests.org_id('g1'), 'Q-000004', 0, 0, 0, 'c1000000-0000-4000-8000-0000000000c1')$$, 'OD429', null, 'archived quotes still count toward the cap');
update private.app_limits set value = 20 where key = 'demo_cap_quotes';

-- ---- clients: read by members of the workspace, never written
select is(tests.visible_count_as('a_viewer', 'public.quotes'), (select count(*) from public.quotes where organization_id = tests.org_id('a')), 'a viewer reads all of the workspace''s quotes');
select is(tests.visible_count_as('a_member', 'public.quote_items'), 1::bigint, 'a member reads its lines (1 left on the approved quote)');
select is(tests.visible_count_as('b_owner', 'public.quotes'), 1::bigint, 'another workspace sees only its own quote');
select is(tests.visible_count_as('outsider', 'public.quotes'), 0::bigint, 'a non-member sees none');
select is(tests.visible_count_as('g1', 'public.quotes'), 2::bigint, 'a guest sees their own demo''s quotes only');
select is(tests.denied_as_anon('select * from public.quotes'), true, 'anon cannot read quotes');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$insert into public.quotes (organization_id, customer_id, quote_number, title) values (tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', 'Q-000050', 'Direct')$$)), 0::bigint, 'owner, admin and member cannot insert a quote directly');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$update public.quotes set total_cents = 1 where id = 'a1000000-0000-4000-8000-000000000001'$$)), 0::bigint, 'nor write a total');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$update public.quotes set quote_number = 'Q-000099' where id = 'a1000000-0000-4000-8000-000000000001'$$)), 0::bigint, 'nor a quote number');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$update public.quotes set status = 'sent' where id = 'a1000000-0000-4000-8000-000000000001'$$)), 0::bigint, 'nor a status');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$delete from public.quotes where id = 'a1000000-0000-4000-8000-000000000001'$$)), 0::bigint, 'nor delete');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (tests.org_id('a'), 'a1000000-0000-4000-8000-000000000001', 1, 'Direct line', 1, 1)$$)), 0::bigint, 'nor insert a line');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$select * from public.quote_sequences$$)), 0::bigint, 'nor read the sequence');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$update public.quote_sequences set next_number = 1$$)), 0::bigint, 'nor write it');
select is((select count(*) from unnest(array['a_owner', 'a_admin', 'a_member']) l where not tests.denied_as(l, $$insert into public.quote_sequences (organization_id, next_number) values (tests.org_id('a'), 1)$$)), 0::bigint, 'nor insert a row into it');
select is(tests.denied_as_anon('insert into public.quote_sequences (organization_id) values (gen_random_uuid())'), true, 'anon cannot touch the sequence either');

select * from finish();
rollback;
