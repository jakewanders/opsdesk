-- pgTAP tests for the demo caps (SIT-200). Caps are lowered through private.app_limits.
begin;
select plan(33);
select tests.create_fixtures();

-- A probe entity table shaped like a real one (organization_id, archived flag, essential flag)
create table public.zz_things (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, name text not null, archived boolean not null default false, essential boolean not null default false);
create index zz_things_org_idx on public.zz_things (organization_id);
grant select, insert, update, delete on public.zz_things to authenticated;
alter table public.zz_things enable row level security;
create policy zz_all on public.zz_things for all to authenticated using (private.is_member(organization_id)) with check (private.is_member(organization_id));
insert into private.app_limits (key, value, note) values ('demo_cap_zz', 3, 'probe cap');

-- ---- the defaults the PRD asks for
select is((select string_agg(key || '=' || value, ', ' order by key) from private.app_limits where key like 'demo_cap_%' and key <> 'demo_cap_zz'),
  'demo_cap_activity_events=300, demo_cap_customers=50, demo_cap_import_jobs=10, demo_cap_opportunities=30, demo_cap_quotes=20, demo_cap_tasks=75', 'default caps: 50 customers, 30 opportunities, 75 tasks, 20 quotes, 10 import jobs, 300 activity events');

-- ---- one-line attach, with guards
select lives_ok($$select private.attach_demo_cap('public.zz_things', 'demo_cap_zz')$$, 'a cap attaches in one line');
select ok(exists (select 1 from pg_trigger where tgrelid = 'public.zz_things'::regclass and tgname = 'zz_things_demo_cap'), 'as a trigger named after the table');
select lives_ok($$select private.attach_demo_cap('public.zz_things', 'demo_cap_zz')$$, 'attaching twice is safe');
select throws_ok($$select private.attach_demo_cap('public.zz_things', 'demo_cap_nope')$$, 'P0001', 'Cannot attach a demo cap: unknown limit "demo_cap_nope"', 'an unknown limit key is refused');
select throws_ok($$select private.attach_demo_cap('public.profiles', 'demo_cap_zz')$$, 'P0001', null, 'a table without organization_id is refused');
select ok(not has_function_privilege('authenticated', 'private.attach_demo_cap(regclass, text, text)', 'execute') and not has_function_privilege('anon', 'private.enforce_demo_cap()', 'execute'), 'browser roles cannot run the cap functions');
select ok((select prosecdef and coalesce('search_path=""' = any (proconfig), false) from pg_proc where oid = 'private.enforce_demo_cap()'::regprocedure), 'the trigger function is SECURITY DEFINER with a pinned search_path');

-- ---- a demo workspace stops at the cap
select tests.act_as('g1');
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'one')$$, 'row 1 of 3');
select ok(exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and granted), 'the insert holds the per-workspace advisory lock (concurrent inserts queue)');
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'two')$$, 'row 2 of 3');
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'three')$$, 'row 3 of 3');
select throws_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'four')$$, 'OD429', 'Demo limit reached for zz things. Reset the demo to start over.', 'row 4 is refused with the cap error');
select is((select count(*) from public.zz_things), 3::bigint, 'and was not inserted');
select tests.reset();
select is(tests.sqlstate_of($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'x')$$), 'OD429', 'as a postgres session too (the cap is not caller-specific)');

-- error shape the API maps to 429
create temp table captured (state text, msg text, detail text, hint text);
do $$
begin
  insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'x');
exception when others then
  declare s text; m text; d text; h text;
  begin
    get stacked diagnostics s = returned_sqlstate, m = message_text, d = pg_exception_detail, h = pg_exception_hint;
    insert into captured values (s, m, d, h);
  end;
end $$;
select is((select state from captured), 'OD429', 'the SQLSTATE is the OD429 the API maps to HTTP 429');
select is((select detail from captured), 'DEMO_CAP', 'with the machine code DEMO_CAP');
select is((select hint from captured), 'retry-after=60', 'and a retry-after hint');

-- archiving does not bypass: archived rows still count
select tests.act_as('g1');
select is(tests.rows_changed($$update public.zz_things set archived = true$$), 3::bigint, 'archive all three');
select throws_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'after archive')$$, 'OD429', null, 'archived rows still count toward the cap');
-- deleting frees room (reset and cleanup stay available)
select tests.rows_changed($$delete from public.zz_things where name = 'one'$$);
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g1'), 'room again')$$, 'deleting a row makes room again');
select tests.reset();

-- ---- other workspaces are independent
select tests.act_as('g2');
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g2'), 'g2-1')$$, 'another guest has their own allowance');
select tests.reset();

-- ---- real organizations are never capped
select tests.act_as('a_owner');
select lives_ok($$insert into public.zz_things (organization_id, name) select tests.org_id('a'), 'real-' || i from generate_series(1, 10) i$$, 'a real organization inserts 10 rows past the cap of 3');
select is((select count(*) from public.zz_things where organization_id = tests.org_id('a')), 10::bigint, 'all 10 are stored');
select tests.reset();

-- ---- bulk insert that would cross the cap fails as a whole
select tests.act_as('g2');
select throws_ok($$insert into public.zz_things (organization_id, name) select tests.org_id('g2'), 'bulk-' || i from generate_series(1, 5) i$$, 'OD429', null, 'a multi-row insert that crosses the cap fails');
select is((select count(*) from public.zz_things), 1::bigint, 'and none of its rows are kept (still only the one from before)');
select tests.reset();

-- ---- lowering and raising the cap takes effect immediately
update private.app_limits set value = 1 where key = 'demo_cap_zz';
select tests.act_as('g2');
select throws_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g2'), 'over the lowered cap')$$, 'OD429', null, 'a lowered cap applies at once');
select tests.reset();
update private.app_limits set value = 5 where key = 'demo_cap_zz';
select tests.act_as('g2');
select lives_ok($$insert into public.zz_things (organization_id, name) values (tests.org_id('g2'), 'g2-2')$$, 'a raised cap lets the guest continue');
select tests.reset();

-- ---- count filter: essential rows do not count (the activity cap leaves audit events out)
create table public.zz_events (id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, essential boolean not null default false);
create index zz_events_org_idx on public.zz_events (organization_id);
insert into private.app_limits (key, value, note) values ('demo_cap_zz_events', 2, 'probe cap');
select private.attach_demo_cap('public.zz_events', 'demo_cap_zz_events', 'not essential');
insert into public.zz_events (organization_id, essential) values (tests.org_id('g1'), true), (tests.org_id('g1'), true), (tests.org_id('g1'), true);
select lives_ok($$insert into public.zz_events (organization_id) values (tests.org_id('g1'))$$, 'essential events are not counted: non-essential event 1 of 2');
select lives_ok($$insert into public.zz_events (organization_id) values (tests.org_id('g1'))$$, 'non-essential event 2 of 2');
select throws_ok($$insert into public.zz_events (organization_id) values (tests.org_id('g1'))$$, 'OD429', null, 'the next non-essential event is refused');

-- ---- a blocked audit event blocks its originating mutation (nothing is silently dropped)
create table public.zz_orders (id uuid primary key default gen_random_uuid(), organization_id uuid not null, label text not null);
create function public.zz_log_order() returns trigger language plpgsql as $$
begin insert into public.zz_events (organization_id) values (new.organization_id); return new; end $$;
create trigger zz_orders_log after insert on public.zz_orders for each row execute function public.zz_log_order();
select throws_ok($$insert into public.zz_orders (organization_id, label) values (tests.org_id('g1'), 'blocked')$$, 'OD429', null, 'when the activity cap is reached the originating mutation fails');
select is((select count(*) from public.zz_orders), 0::bigint, 'and its row was not saved, so no mutation exists without its audit event');

select * from finish();
rollback;
