-- pgTAP tests for demo expiry at the database (SIT-206): after expires_at no write path works, even directly.
begin;
select plan(30);
select tests.create_fixtures();

create table public.zz_items (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, name text not null);
create index zz_items_org_idx on public.zz_items (organization_id);
select private.attach_tenant_rls('public.zz_items');
select throws_ok($$select private.attach_tenant_rls('public.profiles')$$, 'P0001', null, 'a table without organization_id is refused');
select lives_ok($$select private.attach_tenant_rls('public.zz_items')$$, 'attaching again is safe');
select ok(not has_function_privilege('authenticated', 'private.attach_tenant_rls(regclass)', 'execute'), 'browser roles cannot run the template');
select is((select string_agg(policyname, ',' order by policyname) from pg_policies where tablename = 'zz_items'), 'zz_items_delete_writer,zz_items_insert_writer,zz_items_select_member,zz_items_update_writer', 'the four standard policies exist');

select ok(not has_table_privilege('anon', 'public.zz_items', 'select') and not has_table_privilege('anon', 'public.zz_items', 'insert') and has_table_privilege('authenticated', 'public.zz_items', 'insert'), 'the template gives anon nothing and authenticated the four operations (RLS decides which rows)');

-- ---- while the demo is live, the guest can write
select tests.act_as('g1');
select lives_ok($$insert into public.zz_items (organization_id, name) values (tests.org_id('g1'), 'one')$$, 'a live demo accepts an insert');
select is(tests.rows_changed($$update public.zz_items set name = 'one!' where name = 'one'$$), 1::bigint, 'an update');
select tests.reset();
select tests.act_as('a_member');
select lives_ok($$insert into public.zz_items (organization_id, name) values (tests.org_id('a'), 'a-1')$$, 'a real organization''s member writes');
select tests.reset();
select tests.act_as('a_viewer');
select ok(tests.denied($$insert into public.zz_items (organization_id, name) values (tests.org_id('a'), 'viewer')$$), 'a viewer cannot insert');
select is(tests.rows_changed($$update public.zz_items set name = 'v'$$), 0::bigint, 'a viewer cannot update');
select is(tests.rows_changed($$delete from public.zz_items$$), 0::bigint, 'or delete');
select is((select count(*) from public.zz_items), 1::bigint, 'but a viewer reads their organization''s rows');
select tests.reset();
select tests.act_as('b_owner');
select ok(tests.denied(format('insert into public.zz_items (organization_id, name) values (%L, %L)', tests.org_id('a'), 'cross-tenant')), 'another tenant cannot insert into org A');
select is(tests.rows_changed($$update public.zz_items set name = 'x'$$), 0::bigint, 'nor update org A rows');
select is((select count(*) from public.zz_items), 0::bigint, 'nor read them');
select tests.reset();

-- ---- the clock passes expires_at: every write path fails at the database
select private.set_demo_expiry(tests.org_id('g1'), now() - interval '1 second');
select ok((select expires_at < now() from public.organizations where id = tests.org_id('g1')), 'G1''s demo is now past its expiry');
select tests.act_as('g1');
select ok(tests.denied($$insert into public.zz_items (organization_id, name) values (tests.org_id('g1'), 'after expiry')$$), 'INSERT is refused after expiry');
select is(tests.rows_changed($$update public.zz_items set name = 'edited after expiry'$$), 0::bigint, 'UPDATE changes nothing after expiry');
select is(tests.rows_changed($$delete from public.zz_items$$), 0::bigint, 'DELETE changes nothing after expiry');
select ok(tests.denied($$update public.organizations set name = 'renamed after expiry'$$) or tests.rows_changed($$update public.organizations set name = 'renamed after expiry'$$) = 0, 'the organization itself cannot be edited after expiry');
select is((select count(*) from public.zz_items), 1::bigint, 'reads still work until cleanup (the row is still there)');
select is((select name from public.zz_items), 'one!', 'and nothing was changed');
select tests.reset();
select ok(not private.org_is_writable(tests.org_id('g1')), 'org_is_writable is false for it');

-- boundary: exactly now is expired; one second ahead is writable
select private.set_demo_expiry(tests.org_id('g1'), now() + interval '1 second');
select ok(private.org_is_writable(tests.org_id('g1')), 'one second before expiry it is still writable');
select tests.act_as('g1');
select lives_ok($$insert into public.zz_items (organization_id, name) values (tests.org_id('g1'), 'just in time')$$, 'and a write succeeds');
select tests.reset();
select private.set_demo_expiry(tests.org_id('g1'), now());
select ok(not private.org_is_writable(tests.org_id('g1')), 'at exactly expires_at it is expired (the check is strictly "expires_at > now()")');

-- the trusted path (service role) can still manage expired data: cleanup and reset stay available
select tests.act_as_service();
select lives_ok($$delete from public.zz_items where organization_id = tests.org_id('g1')$$, 'cleanup running as the service role can delete an expired demo''s rows');
select tests.reset();

-- ---- a guest cannot revive their demo
select tests.act_as('g1');
select ok(tests.denied($$update public.organizations set expires_at = now() + interval '1 day'$$), 'a guest cannot extend expires_at');
select tests.reset();

-- ---- the template is enforced for every tenant table
select is(
  (select coalesce(string_agg(c.relname || '.' || p.policyname || ' [' || p.cmd || ']', ', ' order by c.relname, p.policyname), '')
     from pg_policies p
     join pg_class c on c.relname = p.tablename and c.relnamespace = 'public'::regnamespace
    where p.schemaname = 'public'
      and p.permissive = 'PERMISSIVE'
      and p.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
      and coalesce(p.qual, '') || coalesce(p.with_check, '') !~ '(can_write|org_is_writable)'),
  '', 'every permissive write policy on a table with organization_id requires a writable organization (can_write / org_is_writable)');
select is(
  (select coalesce(string_agg(p.policyname, ', '), '') from pg_policies p where p.schemaname = 'public' and p.tablename = 'organizations' and p.cmd = 'UPDATE' and p.qual !~ 'org_is_writable'),
  '', 'including the organizations table itself');

select * from finish();
rollback;
