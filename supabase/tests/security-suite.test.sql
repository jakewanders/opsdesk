-- P-04 (SIT-145): the PRD 11.2 database and security suite, consolidated. Every assertion title starts with the bullet it proves:
--   [1]  a member of org A cannot select, update or delete rows in B           [5]  the last owner cannot be removed or demoted
--   [2]  a foreign key cannot link org A to org B                              [6]  no untrusted client writes audit events, money totals, role, org kind or expiry
--   [3]  an anonymous user cannot create a permanent workspace or manage       [7]  SECURITY DEFINER functions reject callers without authority
--        memberships                                                           [8]  reset and cleanup do not touch real orgs or another guest
--   [4]  a viewer cannot write business rows directly
--   [C]  catalog guards: they fail when a later change adds a table, policy, view or function without the protections.
-- Tables are discovered from the catalog, so a NEW table without fixtures or without protection fails here rather than passing quietly.
begin;
select * from no_plan();
select tests.create_fixtures();
-- true when the statement changed nothing: refused for any reason (a missing grant, a failed policy, a protective trigger) or matched 0 rows
create function pg_temp.blocked_as(label text, stmt text) returns boolean language plpgsql as $$
declare n bigint; r boolean;
begin
  perform tests.act_as(label);
  begin
    execute stmt;
    get diagnostics n = row_count;
    r := n = 0;
  exception when others then
    r := true;
  end;
  perform tests.reset();
  return r;
end $$;

create function pg_temp.other_org(tbl text) returns uuid language sql as $$
  select case when tbl = 'demo_workspaces' then tests.org_id('g2') else tests.org_id('b') end
$$;
-- rows of the other workspace a user can see; a table the role has no grant on shows nothing (0)
create function pg_temp.visible_as(label text, tbl text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform tests.act_as(label);
  begin
    execute format('select count(*) from public.%I where organization_id = %L', tbl, pg_temp.other_org(tbl)) into n;
  exception when insufficient_privilege then
    n := 0;
  end;
  perform tests.reset();
  return n;
end $$;

-- ---- fixtures: one row of every tenant table in org B (and A for the foreign-key cases), created by the superuser
insert into public.customers (id, organization_id, display_name) values
  ('c5000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'A customer'),
  ('c5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'B customer');
insert into public.opportunities (id, organization_id, customer_id, title) values
  ('d5000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'c5000000-0000-4000-8000-0000000000a1', 'A deal'),
  ('d5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'c5000000-0000-4000-8000-0000000000b1', 'B deal');
insert into public.tasks (id, organization_id, title) values ('e5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'B task');
insert into public.import_jobs (id, organization_id, created_by, file_sha256, total_rows)
  values ('f5000000-0000-4000-8000-0000000000b1', tests.org_id('b'), tests.uid('b_owner'), repeat('a', 64), 3);
insert into public.invitations (id, organization_id, email_normalized, role, token_hash, invited_by)
  values ('f6000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'x@example.test', 'member', repeat('b', 64), tests.uid('b_owner'));
create function pg_temp.mkquote(who text, org text, cust uuid) returns uuid language plpgsql as $$
declare r public.quotes;
begin
  perform tests.act_as(who);
  select * into r from public.create_quote_with_items(tests.org_id(org), cust, null, 'Quote ' || org, null, null, 0, 0, null,
    '[{"description":"Line","quantity":1,"unitPriceCents":100}]'::jsonb);
  perform tests.reset();
  return r.id;
end $$;
create temp table made (k text primary key, id uuid);
grant select on made to authenticated;
insert into made values
  ('qa', pg_temp.mkquote('a_owner', 'a', 'c5000000-0000-4000-8000-0000000000a1')),
  ('qb', pg_temp.mkquote('b_owner', 'b', 'c5000000-0000-4000-8000-0000000000b1'));

create temp table tenant_tables as
  select c.relname::text as relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped);
grant select on tenant_tables to authenticated;

-- ---- [C] catalog guards
select is((select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity), null,
  '[C1] every table in public has row level security on');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'PUBLIC')), 0::bigint,
  '[C2] anon and PUBLIC hold no privilege on any table or view in public');
select is((select count(*) from information_schema.role_usage_grants where object_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0::bigint,
  '[C3] nobody holds a usage grant on a sequence or other object in public');
select is((select string_agg(table_name || ':' || privilege_type, ', ') from information_schema.role_table_grants
            where table_schema = 'public' and grantee = 'authenticated' and privilege_type in ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')), null,
  '[C4] authenticated can never delete, truncate, reference or add triggers on a table directly (archive is an update)');
select is((select string_agg(table_name || ':' || privs, '; ' order by table_name) from (
              select table_name, string_agg(privilege_type, ',' order by privilege_type) privs from information_schema.role_table_grants
               where table_schema = 'public' and grantee = 'authenticated' group by table_name) g),
  'activity_events:SELECT; customers:INSERT,SELECT,UPDATE; demo_workspaces:SELECT; import_jobs:SELECT; invitations:SELECT; memberships:SELECT; opportunities:INSERT,SELECT,UPDATE; organizations:SELECT; profiles:SELECT; quote_items:SELECT; quotes:SELECT; tasks:INSERT,SELECT,UPDATE',
  '[C14] the signed-in role''s table grants are exactly the reviewed map: writes only on customers, opportunities and tasks (everything else changes through a controlled function)');
select is((select string_agg(tablename || '/' || policyname, ', ') from pg_policies where schemaname = 'public' and roles <> '{authenticated}'::name[]), null,
  '[C5] every policy applies to the authenticated role only, never anon or PUBLIC');
select is((select string_agg(tablename || '/' || policyname, ', ') from pg_policies
            where schemaname = 'public' and (trim(coalesce(qual, '')) in ('true', '(true)') or trim(coalesce(with_check, '')) in ('true', '(true)'))), null,
  '[C6] no policy is a bare "true": every one tests membership, role or ownership');
select is((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname <> 'quote_sequences'
              and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)), null,
  '[C7] every table in public has at least one policy, except quote_sequences, the number counter that only the quote functions touch');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'quote_sequences' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0::bigint,
  '[C7] and quote_sequences (RLS on, no policy) grants nothing to anyone: it is closed to browser roles');
select is((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('v', 'm', 'f') and not (coalesce(c.reloptions, '{}') && array['security_invoker=true', 'security_invoker=on'])), null,
  '[C8] no view in public bypasses row level security (a view must be security_invoker)');
select is((select string_agg(n.nspname || '.' || p.proname, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and p.prosecdef and not coalesce(p.proconfig, '{}') @> array['search_path=""']), null,
  '[C9] every SECURITY DEFINER function pins an empty search_path');
select is((select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and (has_function_privilege('anon', p.oid, 'execute') and p.proname not in ('health_ping'))), null,
  '[C10] the only function a signed-out visitor can call is the health probe');
select is((select string_agg(p.oid::regprocedure::text, ', ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like any (array['cleanup\_%', 'seed\_%', 'register\_%']) and has_function_privilege('authenticated', p.oid, 'execute')), null,
  '[C11] no cleanup, seed or registry function is callable by a signed-in user');
select is((select string_agg(t.relname, ', ') from tenant_tables t
            where not exists (select 1 from pg_constraint k where k.conrelid = ('public.' || quote_ident(t.relname))::regclass and k.contype = 'f' and k.confrelid = 'public.organizations'::regclass)), null,
  '[C12] every tenant table references organizations');
-- the coverage guard: every tenant table must have a fixture row in the other workspace (B; the demo registry's is G2), or the loops below would pass vacuously
create function pg_temp.rows_in_b(tbl text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I where organization_id = %L', tbl, pg_temp.other_org(tbl)) into n;
  return n;
end $$;
select is((select string_agg(t.relname, ', ') from tenant_tables t where pg_temp.rows_in_b(t.relname) = 0), null,
  '[C13] every tenant table has a fixture row in the other workspace (a new table without one fails here: add its fixture)');

-- ---- [1] a member of A cannot select, update or delete rows in B, in EVERY tenant table (discovered, not listed)
select is(pg_temp.visible_as('a_member', t.relname), 0::bigint,
  format('[1] a_member of A sees no row of another workspace in %s', t.relname))
  from (select relname from tenant_tables order by relname) t;
select is(tests.visible_count_as('a_member', 'public.organizations', format('id = %L', tests.org_id('b'))), 0::bigint, '[1] a_member of A cannot see the organization row of B');
select ok(pg_temp.blocked_as('a_owner', format('update public.%I set organization_id = organization_id where organization_id = %L', t.relname, pg_temp.other_org(t.relname))),
  format('[1] even A''s owner changes no row of B in %s', t.relname))
  from (select relname from tenant_tables order by relname) t;
select ok(pg_temp.blocked_as('a_owner', format('delete from public.%I where organization_id = %L', t.relname, pg_temp.other_org(t.relname))),
  format('[1] even A''s owner deletes no row of B in %s', t.relname))
  from (select relname from tenant_tables order by relname) t;

-- controls: the statements above are real, the owner of A DOES change A's own rows (so "blocked" is not a typo passing quietly)
select is(tests.rows_changed_as('a_owner', format($$update public.customers set organization_id = organization_id where organization_id = %L$$, tests.org_id('a'))), 1::bigint, '[1] control: A''s owner changes A''s own customer');
select is(tests.rows_changed_as('a_member', format($$update public.customers set display_name = 'edited by a member' where organization_id = %L$$, tests.org_id('a'))), 1::bigint, '[1] control: A''s member edits A''s own customer');

-- ---- [2] a foreign key cannot link org A to org B (the superuser, so only the constraint itself can stop it)
select throws_ok(format($$insert into public.opportunities (organization_id, customer_id, title) values (%L, 'c5000000-0000-4000-8000-0000000000b1', 'cross')$$, tests.org_id('a')),
  '23503', null, '[2] an opportunity of A cannot point at a customer of B');
select throws_ok(format($$insert into public.tasks (organization_id, title, customer_id) values (%L, 'cross', 'c5000000-0000-4000-8000-0000000000b1')$$, tests.org_id('a')),
  '23503', null, '[2] a task of A cannot point at a customer of B');
select throws_ok(format($$insert into public.tasks (organization_id, title, opportunity_id) values (%L, 'cross', 'd5000000-0000-4000-8000-0000000000b1')$$, tests.org_id('a')),
  '23503', null, '[2] a task of A cannot point at a deal of B');
select throws_ok(format($$insert into public.quotes (organization_id, customer_id, quote_number, title) values (%L, 'c5000000-0000-4000-8000-0000000000b1', 'Q-999998', 'cross')$$, tests.org_id('a')),
  '23503', null, '[2] a quote of A cannot point at a customer of B');
select throws_ok(format($$update public.opportunities set customer_id = 'c5000000-0000-4000-8000-0000000000b1' where id = 'd5000000-0000-4000-8000-0000000000a1'$$),
  '23503', null, '[2] moving a deal of A to a customer of B is refused too');
select throws_ok(format($$insert into public.quote_items (organization_id, quote_id, position, description, quantity, unit_price_cents) values (%L, %L, 99, 'Line item', 1, 1)$$, tests.org_id('a'), (select id from made where k = 'qb')),
  '23503', null, '[2] a quote line of A cannot hang on a quote of B');
-- (an event is only ever written by the database's own triggers, never by a client: see [6]; it has no foreign key to the record it describes)
select tests.reset();

-- ---- [3] an anonymous user cannot create a permanent workspace or manage memberships
select is(tests.sqlstate_of_as('g1', $$select public.create_real_organization('Permanent', null, 'UTC')$$), 'OD403', '[3] an anonymous guest cannot create a permanent workspace');
select ok(tests.denied_as_anon($$select public.create_real_organization('Permanent', null, 'UTC')$$), '[3] and neither can a signed-out visitor');
select is(tests.sqlstate_of_as('g1', format($$select public.create_invitation(%L, 'friend@example.test', 'member')$$, tests.org_id('g1'))), 'OD403', '[3] a guest cannot invite anyone, even into their own demo');
select is(tests.sqlstate_of_as('g1', format($$select public.change_membership(%L, %L, 'admin', false)$$, tests.org_id('g1'), tests.uid('g1'))), 'OD403', '[3] a guest cannot change a membership, even their own');
select ok(pg_temp.blocked_as('g1', format($$insert into public.memberships (organization_id, user_id, role) values (%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('g1'))), '[3] a guest cannot add themselves to a real workspace');
select ok(pg_temp.blocked_as('g1', format($$update public.organizations set kind = 'real', expires_at = null where id = %L$$, tests.org_id('g1'))), '[3] a guest cannot turn their demo into a permanent organization');

-- ---- [4] a viewer cannot write business rows directly (HTTP side: endpoint-matrix.integration.test.ts)
select ok(pg_temp.blocked_as('a_viewer', format($$insert into public.customers (organization_id, display_name) values (%L, 'viewer made')$$, tests.org_id('a'))), '[4] a viewer cannot insert a customer');
select ok(pg_temp.blocked_as('a_viewer', $$update public.customers set display_name = 'viewer edit' where id = 'c5000000-0000-4000-8000-0000000000a1'$$), '[4] a viewer cannot update a customer');
select ok(pg_temp.blocked_as('a_viewer', $$update public.opportunities set title = 'viewer edit' where id = 'd5000000-0000-4000-8000-0000000000a1'$$), '[4] a viewer cannot update a deal');
select ok(pg_temp.blocked_as('a_viewer', format($$insert into public.tasks (organization_id, title) values (%L, 'viewer task')$$, tests.org_id('a'))), '[4] a viewer cannot insert a task');
select is(tests.sqlstate_of_as('a_viewer', format($$select public.create_quote_with_items(%L, 'c5000000-0000-4000-8000-0000000000a1', null, 't', null, null, 0, 0, null, '[]'::jsonb)$$, tests.org_id('a'))), 'OD403', '[4] a viewer cannot create a quote');
select is(tests.sqlstate_of_as('a_viewer', format($$select public.transition_quote(%L, 1, 'sent')$$, (select id from made where k = 'qa'))), 'OD403', '[4] a viewer cannot send a quote');
select ok(tests.denied_as('a_viewer', format($$update public.quotes set title = 'x' where id = %L$$, (select id from made where k = 'qa'))), '[4] and cannot touch the quote table directly (no grant)');
select is(tests.sqlstate_of_as('a_viewer', format($$select public.create_invitation(%L, 'y@example.test', 'viewer')$$, tests.org_id('a'))), 'OD403', '[4] a viewer cannot invite');
select is(tests.visible_count_as('a_viewer', 'public.customers', format('organization_id = %L', tests.org_id('a'))), 1::bigint, '[4] while a viewer still reads the workspace''s rows (control)');

-- ---- [5] the last owner cannot be removed or demoted
select is(tests.sqlstate_of_as('a_owner', format($$select public.change_membership(%L, %L, 'admin', false)$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD409', '[5] the only owner cannot demote themselves');
select is(tests.sqlstate_of_as('a_owner', format($$select public.change_membership(%L, %L, null, true)$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD409', '[5] the only owner cannot remove themselves');
select is(tests.sqlstate_of_as('a_admin', format($$select public.change_membership(%L, %L, 'viewer', false)$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD403', '[5] an admin cannot demote the owner at all');

-- ---- [6] no untrusted client writes audit events, money totals, role, org kind or expiry
select ok(tests.denied_as('a_owner', format($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, 'customer', 'c5000000-0000-4000-8000-0000000000a1', 'updated', 'forged')$$, tests.org_id('a'))), '[6] an owner cannot write an audit event');
select ok(tests.denied_as('a_owner', format($$update public.activity_events set summary = 'rewritten' where organization_id = %L$$, tests.org_id('a'))), '[6] nor rewrite one');
select ok(tests.denied_as('a_owner', format($$update public.quotes set total_cents = 1, subtotal_cents = 1, tax_cents = 0 where id = %L$$, (select id from made where k = 'qa'))), '[6] nobody sets a quote''s money totals directly');
select ok(tests.denied_as('a_owner', format($$update public.quote_items set unit_price_cents = 1 where quote_id = %L$$, (select id from made where k = 'qa'))), '[6] nor a quote line''s amounts');
select ok(tests.denied_as('a_owner', format($$insert into public.quotes (organization_id, customer_id, quote_number, title, total_cents) values (%L, 'c5000000-0000-4000-8000-0000000000a1', 'Q-999997', 't', 99)$$, tests.org_id('a'))), '[6] nor insert a quote carrying its own totals');
select ok(pg_temp.blocked_as('a_owner', format($$update public.memberships set role = 'owner' where organization_id = %L and user_id = %L$$, tests.org_id('a'), tests.uid('a_member'))), '[6] a role cannot be set by a direct update, even by the owner');
select ok(pg_temp.blocked_as('a_member', format($$update public.memberships set role = 'owner' where organization_id = %L and user_id = %L$$, tests.org_id('a'), tests.uid('a_member'))), '[6] a member cannot promote themselves');
select ok(pg_temp.blocked_as('a_owner', format($$update public.organizations set kind = 'demo', expires_at = now() + interval '1 hour' where id = %L$$, tests.org_id('a'))), '[6] an organization''s kind cannot be changed by its owner');
select ok(pg_temp.blocked_as('g1', format($$update public.organizations set expires_at = now() + interval '30 days' where id = %L$$, tests.org_id('g1'))), '[6] a guest cannot extend their demo''s expiry');
select ok(pg_temp.blocked_as('a_owner', format($$update public.organizations set created_by = %L where id = %L$$, tests.uid('outsider'), tests.org_id('a'))), '[6] nor change who created an organization');
select ok(pg_temp.blocked_as('a_member', format($$update public.customers set created_by = %L, organization_id = %L where id = 'c5000000-0000-4000-8000-0000000000a1'$$, tests.uid('outsider'), tests.org_id('b'))), '[6] a record cannot be moved to another organization or given another creator');
select ok(tests.denied_as('a_owner', format($$insert into public.import_jobs (organization_id, file_sha256, total_rows) values (%L, repeat('c', 64), 1)$$, tests.org_id('a'))), '[6] import jobs are written only by the controlled functions');

-- ---- [7] SECURITY DEFINER functions reject callers without authority (every browser-callable one; a new one must be added)
create temp table definers (fn text, who text, stmt text, expect text);
insert into definers
select * from (values
  ('change_membership', 'outsider', format($$select public.change_membership(%L, %L, 'viewer', false)$$, tests.org_id('a'), tests.uid('a_member')), 'OD404'),
  ('commit_customer_import', 'outsider', $$select public.commit_customer_import('00000000-0000-4000-8000-000000000001', '[]'::jsonb)$$, 'OD404'),
  ('create_invitation', 'outsider', format($$select public.create_invitation(%L, 'x@example.test', 'viewer')$$, tests.org_id('a')), 'OD404'),
  ('create_quote_with_items', 'outsider', format($$select public.create_quote_with_items(%L, null, null, 't', null, null, 0, 0, null, '[]'::jsonb)$$, tests.org_id('a')), 'OD404'),
  ('create_real_organization', 'g1', $$select public.create_real_organization('Perm', null, 'UTC')$$, 'OD403'),
  ('bootstrap_demo_workspace', 'outsider', $$select public.bootstrap_demo_workspace()$$, 'OD403'),
  ('list_activity', 'outsider', format($$select public.list_activity(%L)$$, tests.org_id('a')), 'OD404'),
  ('list_workspace_members', 'outsider', format($$select public.list_workspace_members(%L)$$, tests.org_id('a')), 'OD404'),
  ('record_import_preview', 'outsider', format($$select public.record_import_preview(%L, repeat('d', 64), 1, 1, '{}'::jsonb)$$, tests.org_id('a')), 'OD404'),
  ('reset_demo_workspace', 'outsider', format($$select public.reset_demo_workspace(%L)$$, tests.org_id('g1')), 'OD403'),
  ('revise_quote', 'outsider', $$select public.revise_quote('00000000-0000-4000-8000-000000000001')$$, 'OD404'),
  ('revoke_invitation', 'outsider', $$select public.revoke_invitation('00000000-0000-4000-8000-000000000001')$$, 'OD404'),
  ('transition_quote', 'outsider', $$select public.transition_quote('00000000-0000-4000-8000-000000000001', 1, 'sent')$$, 'OD404'),
  ('update_draft_quote', 'outsider', $$select public.update_draft_quote('00000000-0000-4000-8000-000000000001', 1, null, null, 't', null, null, 0, 0, null, '[]'::jsonb)$$, 'OD404')
) v(fn, who, stmt, expect);
grant select on definers to authenticated;
select is(tests.sqlstate_of_as(who, stmt), expect, format('[7] %s rejects %s without authority (%s)', fn, who, expect)) from definers order by fn;
-- the remaining browser-callable definers authorize by the caller's own identity or by a secret token, not by an organization:
--   idempotency_* keys are scoped to auth.uid() (idempotency.test.sql); redeem_invitation / preview_invitation need the token (membership-functions.test.sql, invitations.test.sql)
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
              and p.proname not in (select fn from definers) and p.proname not like 'idempotency\_%' and p.proname not in ('redeem_invitation', 'preview_invitation')), null,
  '[7] every browser-callable SECURITY DEFINER function is in the table above (a new one fails here until its rejection test is added)');
select is(tests.sqlstate_of_as('outsider', $$select public.idempotency_begin('POST /x', 'key-outsider-0001', 'hash-one')$$), 'ok', '[7] idempotency keys are the caller''s own (control: works for any signed-in user, scoped to auth.uid(); idempotency.test.sql proves two users never share one)');

-- ---- [8] reset and cleanup do not touch real orgs or another guest
create temp table before_reset as
  select (select count(*) from public.customers where organization_id = tests.org_id('a')) a_cust,
         (select count(*) from public.customers where organization_id = tests.org_id('g2')) g2_cust,
         (select count(*) from public.organizations where kind = 'real') real_orgs;
select is(tests.sqlstate_of_as('g1', format($$select public.reset_demo_workspace(%L)$$, tests.org_id('g1'))), 'ok', '[8] a guest can reset their own demo');
select is(tests.sqlstate_of_as('g1', format($$select public.reset_demo_workspace(%L)$$, tests.org_id('g2'))), 'OD404', '[8] but not another guest''s (the other demo is hidden: not found)');
select is(tests.sqlstate_of_as('g1', format($$select public.reset_demo_workspace(%L)$$, tests.org_id('a'))), 'OD404', '[8] and not a real organization they do not belong to (hidden: not found)');
select is((select count(*) from public.customers where organization_id = tests.org_id('g2')), (select g2_cust from before_reset), '[8] the other guest''s data is unchanged by the reset');
select is((select count(*) from public.customers where organization_id = tests.org_id('a')), (select a_cust from before_reset), '[8] so is the real organization''s');
select is(tests.sqlstate_of_as('a_owner', $$select public.cleanup_purge_expired_demos(10)$$), '42501', '[8] a signed-in user cannot run the cleanup');
select tests.act_as_service();
select lives_ok($$select public.cleanup_purge_expired_demos(50)$$, '[8] the service role runs it');
select tests.reset();
select is((select count(*) from public.organizations where id = tests.org_id('expired')), 0::bigint, '[8] cleanup removed the expired demo');
select is((select count(*) from public.organizations where id in (tests.org_id('a'), tests.org_id('b'), tests.org_id('g1'), tests.org_id('g2'))), 4::bigint, '[8] and left both real organizations and both live demos');
select is((select count(*) from public.organizations where kind = 'real'), (select real_orgs from before_reset), '[8] the number of real organizations is unchanged');

select * from finish();
rollback;
