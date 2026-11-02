-- SIT-212: the M1 exit criteria for the public demo, written as acceptance tests (PRD 8.4, 11.2, 12 M1).
-- Database half: guest A/B isolation, escalation attempts, throttles, expiry, and two catalog guards that fail when a
-- later issue adds a function or tenant table without the demo protections. Re-run on every entity issue.
begin;
select plan(42);
select tests.create_fixtures();

-- ---- catalog guard 1: only these public functions are callable by browser roles
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  'bootstrap_demo_workspace(), change_membership(uuid,uuid,text,boolean), create_invitation(uuid,text,text), create_real_organization(text,text,text), dashboard_summary(uuid), health_ping(), idempotency_abandon(text,text), idempotency_begin(text,text,text), idempotency_complete(text,text,integer,jsonb), list_activity(uuid,text,uuid,text,uuid,boolean,date,date,boolean,integer,integer), list_workspace_members(uuid), move_opportunity_stage(uuid,text,text,timestamp with time zone), preview_invitation(text), redeem_invitation(text), reset_demo_workspace(uuid), revoke_invitation(uuid)',
  'the callable surface is exactly the reviewed list (a new public function must be reviewed and added here)');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'cleanup\_%' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))), 0::bigint,
  'no cleanup or administrator function is callable by a guest or a visitor');
select is((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'private' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))),
  'private.can_write(uuid), private.current_user_id(), private.has_role(uuid,text[]), private.is_anonymous(), private.is_member(uuid), private.is_valid_timezone(text), private.org_is_writable(uuid), private.valid_tags(text[])',
  'only the row-level-security helpers (and the tags CHECK helper) are callable in the private schema (no seed, cleanup or admin function)');

-- ---- the health probe (SIT-186) reads nothing and is callable by a visitor
select is((select public.health_ping()), true, 'health_ping answers true');
select is(has_function_privilege('anon', 'public.health_ping()', 'execute'), true, 'a visitor can call it (the health endpoint has no session)');
select is((select prosrc from pg_proc where oid = 'public.health_ping()'::regprocedure), ' select true ', 'and it is just "select true": no table, no data');

-- ---- catalog guard 2: every tenant table has RLS; every entity table has a demo cap
select is((select string_agg(c.relname, ', ') from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), null, 'every public table has row level security on');
select is((select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped)
              and c.relname not in ('memberships', 'demo_workspaces', 'invitations', 'quote_items', 'quote_sequences')
              and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname like '%\_demo\_cap')), null,
  'every tenant entity table carries a demo cap trigger (memberships and demo_workspaces are bounded by their own rules; invitations exist only in real workspaces, which have no caps; quote_items are bounded by their quote and quote_sequences has one row per organization)');

-- ---- guest A and guest B each have a demo (fixtures g1, g2); A tries everything against B
select tests.act_as('g1');
select is((select count(*) from public.organizations), 1::bigint, 'A enumerates organizations: only their own');
select is((select count(*) from public.memberships), 1::bigint, 'A enumerates memberships: only their own');
select is((select count(*) from public.demo_workspaces), 1::bigint, 'A enumerates demo workspaces: only their own');
select is(tests.visible_count('public.organizations', format('id = %L', tests.org_id('g2'))), 0::bigint, 'A cannot fetch B''s organization by id');
select is(tests.visible_count('public.memberships', format('organization_id = %L', tests.org_id('g2'))), 0::bigint, 'nor B''s membership');
select is(tests.visible_count('public.organizations', format('id = %L', tests.org_id('a'))), 0::bigint, 'nor a real organization');
select is(tests.blocked(format('update public.organizations set name = ''hijacked'' where id = %L', tests.org_id('g2'))), true, 'A cannot mutate B''s organization');
select is(tests.blocked(format('delete from public.organizations where id = %L', tests.org_id('g2'))), true, 'A cannot delete B''s organization');
select is(tests.blocked(format('update public.memberships set role = ''viewer'' where organization_id = %L', tests.org_id('g2'))), true, 'A cannot touch B''s membership');
select throws_ok(format('select public.reset_demo_workspace(%L)', tests.org_id('g2')), 'OD404', null, 'A cannot reset B''s demo (reported as not found, like an unknown id)');
select throws_ok(format('select public.reset_demo_workspace(%L)', tests.org_id('a')), 'OD404', null, 'nor a real organization');

-- ---- escalation: A cannot become a real tenant, invite, change roles or extend the expiry
select throws_ok($$select public.create_real_organization('Mine', null, 'UTC')$$, 'OD403', null, 'A cannot create a real organization');
select is(tests.denied($$insert into public.organizations (name, kind, created_by) values ('Sneaky', 'real', auth.uid())$$), true, 'nor insert one directly');
select is(tests.denied(format('insert into public.memberships (organization_id, user_id, role) values (%L, %L, ''member'')', tests.org_id('g1'), tests.uid('outsider'))), true, 'A cannot invite a member into their own demo');
select is(tests.blocked(format('update public.memberships set role = ''viewer'' where organization_id = %L', tests.org_id('g1'))), true, 'A cannot edit a role, not even their own');
select is(tests.blocked(format('update public.organizations set expires_at = now() + interval ''30 days'' where id = %L', tests.org_id('g1'))), true, 'A cannot extend the expiry');
select is(tests.blocked(format('update public.organizations set kind = ''real'', expires_at = null where id = %L', tests.org_id('g1'))), true, 'nor turn their demo into a real organization');
select is(tests.denied($$select public.cleanup_purge_expired_demos(50)$$), true, 'A cannot call the cleanup');
select is(tests.denied($$select public.cleanup_next_users(10, now())$$), true, 'nor its user queue');
select is(tests.denied($$select private.seed_demo_workspace(gen_random_uuid())$$), true, 'nor the seed runner');
select is((select expires_at from public.organizations where id = tests.org_id('g1')) < now() + interval '25 hours', true, 'and the expiry is still about 24 hours');
select tests.reset();

-- ---- two guests bootstrapping the same seed get separate, overlapping content (probe seeder)
create table public.zz_seeded (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations (id) on delete cascade, name text not null);
alter table public.zz_seeded enable row level security;
create policy zz_member on public.zz_seeded for all to authenticated using (private.is_member(organization_id)) with check (private.is_member(organization_id));
grant select, insert, update, delete on public.zz_seeded to authenticated;
create function private.zz_seed(org uuid) returns void language plpgsql as $$ begin insert into public.zz_seeded (organization_id, name) values (org, 'Acme Plumbing'), (org, 'Riverbend Roofing'); end $$;
create function private.zz_clear(org uuid) returns void language plpgsql as $$ begin delete from public.zz_seeded where organization_id = org; end $$;
select private.register_demo_seeder('zz_seeded', 500, 'private.zz_seed(uuid)'::regprocedure, 1, 'private.zz_clear(uuid)'::regprocedure);
insert into auth.users (id, email, is_anonymous) values ('aa000000-0000-4000-8000-0000000000a1', null, true), ('aa000000-0000-4000-8000-0000000000b2', null, true);
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
create temp table boot_a as select public.bootstrap_demo_workspace() r;
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000b2', true);
create temp table boot_b as select public.bootstrap_demo_workspace() r;
grant select on boot_a, boot_b to authenticated;
select isnt((select r->>'organization_id' from boot_a), (select r->>'organization_id' from boot_b), 'A and B get different organizations');
select tests.reset();
select is((select count(distinct id) from public.zz_seeded where organization_id in ((select (r->>'organization_id')::uuid from boot_a), (select (r->>'organization_id')::uuid from boot_b))), 4::bigint, 'with four separate record ids');
select is((select count(distinct name) from public.zz_seeded where organization_id in ((select (r->>'organization_id')::uuid from boot_a), (select (r->>'organization_id')::uuid from boot_b))), 2::bigint, 'and the same two seed names in both');
select tests.act_as_uid('aa000000-0000-4000-8000-0000000000a1', true);
select is((select count(*) from public.zz_seeded), 2::bigint, 'A sees only their own two records');
select is(tests.rows_changed(format('update public.zz_seeded set name = ''x'' where organization_id = %L', (select r->>'organization_id' from boot_b))), 0::bigint, 'A cannot mutate B''s seeded records by id');
select is(public.bootstrap_demo_workspace()->>'organization_id', (select r->>'organization_id' from boot_a), 'bootstrapping again returns the same organization (idempotent)');
select is(public.bootstrap_demo_workspace()->>'created', 'false', 'and says it was not created again');

-- ---- repeated reset is bounded
select lives_ok(format('select public.reset_demo_workspace(%L)', (select r->>'organization_id' from boot_a)), 'a first reset works');
select throws_ok(format('select public.reset_demo_workspace(%L)', (select r->>'organization_id' from boot_a)), 'OD429', null, 'an immediate second reset is throttled (429)');
select tests.reset();

-- ---- an expired guest: no writes, cleanup removes only their workspace, a fresh demo can start
select tests.act_as('g3');
select is(tests.blocked(format('update public.organizations set name = ''late'' where id = %L', tests.org_id('expired'))), true, 'an expired guest cannot write (rename refused)');
select tests.reset();
select tests.act_as_service();
select is((public.cleanup_purge_expired_demos(50)->>'orgs_deleted')::int >= 1, true, 'cleanup (service role) deletes the expired workspace');
select tests.reset();
select is((select count(*) from public.organizations where id in (tests.org_id('g1'), tests.org_id('g2'), tests.org_id('a'), tests.org_id('b'))), 4::bigint, 'and no live demo or real organization');
select is((select count(*) from public.organizations where id = tests.org_id('expired')), 0::bigint, 'the expired one is gone');

select * from finish();
rollback;
