-- SIT-254: the M2 role-aware and cross-tenant matrix for every P0 entity (PRD 5.3, 8.4, 11.2, 12 M2).
--
-- ONE generated table of cells (entity, actor, organization, action); each cell is run for real, as that actor, against the
-- real row-level security and grants, and compared with the result the rules predict:
--   entities  customers, opportunities, tasks      actions  select, update, delete, insert, protect_org, protect_creator
--   entity    activity_events                      actions  select, insert, update, delete
--   actors    the four roles of org A, org B's owner and viewer, a user with no organization, three anonymous guests
--             (g1 and g2 own live demos, g3 owns an EXPIRED one) and the signed-out visitor
--   orgs      a, b (real), g1, g2 (live demos), expired (an expired demo)
-- Results: select -> rows seen ('1' or '0'; events: '1' when any); update -> rows changed; insert -> 'ok'; delete, and anything the
-- database refuses with a privilege error -> 'denied'; protect_* -> 'blocked' (a refusal OR no row changed; 'CHANGED' would be a leak).
-- To cover a new entity (quotes, invitations in M4) add its row to `ents` (table, text column, insert statement) and its fixture
-- rows below; the cells, the expectations and the assertions follow from that.
begin;
select plan(1223);
select tests.create_fixtures();

-- ---- who belongs where (the rules' only input besides the role); viewer is read-only; the `expired` demo rejects every write
create temp table m2_members (actor text, org text, role text);
insert into m2_members values
  ('a_owner', 'a', 'owner'), ('a_admin', 'a', 'admin'), ('a_member', 'a', 'member'), ('a_viewer', 'a', 'viewer'),
  ('b_owner', 'b', 'owner'), ('b_viewer', 'b', 'viewer'),
  ('g1', 'g1', 'owner'), ('g2', 'g2', 'owner'), ('g3', 'expired', 'owner');
grant select on m2_members to authenticated;

-- ---- one target row per entity per organization, created by the superuser (so nothing depends on RLS)
create temp table m2_rows (entity text, org text, id uuid, primary key (entity, org));
do $$
declare o text; cid uuid; oid uuid; tid uuid;
begin
  foreach o in array array['a', 'b', 'g1', 'g2', 'expired'] loop
    cid := gen_random_uuid(); oid := gen_random_uuid(); tid := gen_random_uuid();
    insert into public.customers (id, organization_id, display_name) values (cid, tests.org_id(o), 'M2 customer ' || o);
    insert into public.opportunities (id, organization_id, customer_id, title) values (oid, tests.org_id(o), cid, 'M2 deal ' || o);
    insert into public.tasks (id, organization_id, title) values (tid, tests.org_id(o), 'M2 task ' || o);
    insert into m2_rows values ('customers', o, cid), ('opportunities', o, oid), ('tasks', o, tid);
  end loop;
end $$;
grant select on m2_rows to authenticated;

-- ---- run a statement as an actor and report what happened
--   mode 'count': the statement returns one number; 'rows': a data change, report rows changed; 'ok': report 'ok' when it succeeds
create function pg_temp.try_as(actor text, stmt text, mode text) returns text language plpgsql as $$
declare n bigint; res text;
begin
  if actor = 'anon' then perform tests.act_as_anon(); else perform tests.act_as(actor); end if;
  begin
    if mode = 'count' then
      execute stmt into n; res := n::text;
    else
      execute stmt; get diagnostics n = row_count;
      res := case when mode = 'ok' then 'ok' else n::text end;
    end if;
  exception
    when insufficient_privilege then res := 'denied';
    when foreign_key_violation then res := 'fk';
    when others then res := 'err:' || sqlstate;
  end;
  perform tests.reset();
  return res;
end $$;

-- ---- the entities: table, a text column that is safe to edit, and an INSERT for a row in organization %1$L
create temp table ents (entity text primary key, col text, insert_sql text);
insert into ents values
  ('customers', 'display_name', $$insert into public.customers (organization_id, display_name) values (%1$L, 'M2 inserted')$$),
  ('opportunities', 'title', $$insert into public.opportunities (organization_id, customer_id, title) values (%1$L, %2$L, 'M2 inserted')$$),
  ('tasks', 'title', $$insert into public.tasks (organization_id, title) values (%1$L, 'M2 inserted')$$);

-- ---- the cell that is run
create function pg_temp.eval(entity text, actor text, org text, action text) returns text language plpgsql as $$
declare
  org_id uuid := tests.org_id(org);
  other_id uuid := tests.org_id(case when org = 'b' then 'a' else 'b' end);
  target uuid; col text; ins text; cust uuid; stmt text; mode text; raw text;
begin
  if entity = 'activity_events' then
    stmt := case action
      when 'select' then format('select count(*) from public.activity_events where organization_id = %L', org_id)
      when 'insert' then format('insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (%L, ''customer'', gen_random_uuid(), ''created'', ''forged'')', org_id)
      when 'update' then format('update public.activity_events set summary = ''tampered'' where organization_id = %L', org_id)
      when 'delete' then format('delete from public.activity_events where organization_id = %L', org_id)
    end;
    mode := case action when 'select' then 'count' else 'rows' end;
    raw := pg_temp.try_as(actor, stmt, mode);
    return case when action = 'select' and raw ~ '^[0-9]+$' then (raw::bigint > 0)::int::text else raw end;
  end if;

  select r.id into target from m2_rows r where r.entity = eval.entity and r.org = eval.org;
  select e.col, e.insert_sql into col, ins from ents e where e.entity = eval.entity;
  select r.id into cust from m2_rows r where r.entity = 'customers' and r.org = eval.org;
  stmt := case action
    when 'select' then format('select count(*) from public.%I where id = %L', entity, target)
    when 'update' then format('update public.%I set %I = %I || ''!'' where id = %L', entity, col, col, target)
    when 'delete' then format('delete from public.%I where id = %L', entity, target)
    when 'insert' then format(ins, org_id, cust)
    when 'protect_org' then format('update public.%I set organization_id = %L where id = %L', entity, other_id, target)
    when 'protect_creator' then format('update public.%I set created_by = %L where id = %L', entity, tests.uid('b_owner'), target)
  end;
  mode := case action when 'select' then 'count' when 'insert' then 'ok' else 'rows' end;
  raw := pg_temp.try_as(actor, stmt, mode);
  if action like 'protect_%' then
    return case when raw = '0' or raw !~ '^[0-9]+$' then 'blocked' else 'CHANGED' end;
  end if;
  return raw;
end $$;

-- ---- what the rules say should happen (written independently of eval, from the policy in plain words)
create function pg_temp.expect(entity text, actor text, org text, action text) returns text language plpgsql as $$
declare role_ text; member boolean; writer boolean;
begin
  select m.role into role_ from m2_members m where m.actor = expect.actor and m.org = expect.org;
  member := role_ is not null;
  writer := member and role_ <> 'viewer' and expect.org <> 'expired';
  if action like 'protect_%' then return 'blocked'; end if;
  if actor = 'anon' then return 'denied'; end if;          -- the signed-out role holds no grant on any of these tables
  if entity = 'activity_events' then
    return case action when 'select' then case when member then '1' else '0' end else 'denied' end;
  end if;
  return case action
    when 'select' then case when member then '1' else '0' end
    when 'update' then case when writer then '1' else '0' end
    when 'delete' then 'denied'                              -- nobody can delete: records are archived
    when 'insert' then case when writer then 'ok' else 'denied' end
  end;
end $$;

-- ---- the cells
create temp table m2_cells as
  select e.entity, a.actor, o.org, x.action
  from (values ('customers'), ('opportunities'), ('tasks')) e(entity)
  cross join (values ('a_owner'), ('a_admin'), ('a_member'), ('a_viewer'), ('b_owner'), ('b_viewer'), ('outsider'), ('g1'), ('g2'), ('g3'), ('anon')) a(actor)
  cross join (values ('a'), ('b'), ('g1'), ('g2'), ('expired')) o(org)
  cross join (values ('select'), ('update'), ('delete'), ('insert'), ('protect_org'), ('protect_creator')) x(action)
  union all
  select 'activity_events', a.actor, o.org, x.action
  from (values ('a_owner'), ('a_admin'), ('a_member'), ('a_viewer'), ('b_owner'), ('b_viewer'), ('outsider'), ('g1'), ('g2'), ('g3'), ('anon')) a(actor)
  cross join (values ('a'), ('b'), ('g1'), ('g2'), ('expired')) o(org)
  cross join (values ('select'), ('insert'), ('update'), ('delete')) x(action);

select is((select count(*) from m2_cells), 1210::bigint, 'the matrix has 3 entities x 11 actors x 5 organizations x 6 actions plus activity events x 11 x 5 x 4');
select is((select count(*) from m2_cells where entity = 'customers' and actor = 'outsider' and org = 'a' and action = 'select'), 1::bigint, 'every cell exists exactly once');

-- Every cell, asserted. A weakened policy, grant or trigger turns a named cell red.
select is(pg_temp.eval(entity, actor, org, action), pg_temp.expect(entity, actor, org, action), format('%s %s as %s in %s', action, entity, actor, org))
from m2_cells order by entity, actor, org, action;

-- ---- linking across tenants: composite foreign keys (a writer of org A cannot attach anything of org B, or a non-member)
create function pg_temp.row_of(entity text, org text) returns uuid language sql as $$ select id from m2_rows r where r.entity = row_of.entity and r.org = row_of.org $$;
select is(pg_temp.try_as('a_member', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, %L, ''link'')', tests.org_id('a'), pg_temp.row_of('customers', 'b')), 'ok'), 'fk', 'an opportunity of org A cannot point at a customer of org B');
select is(pg_temp.try_as('a_member', format('insert into public.opportunities (organization_id, customer_id, title) values (%L, %L, ''link'')', tests.org_id('a'), pg_temp.row_of('customers', 'g1')), 'ok'), 'fk', 'nor at a customer of a demo workspace');
select is(pg_temp.try_as('a_member', format('insert into public.tasks (organization_id, customer_id, title) values (%L, %L, ''link'')', tests.org_id('a'), pg_temp.row_of('customers', 'b')), 'ok'), 'fk', 'a task of org A cannot point at a customer of org B');
select is(pg_temp.try_as('a_member', format('insert into public.tasks (organization_id, opportunity_id, title) values (%L, %L, ''link'')', tests.org_id('a'), pg_temp.row_of('opportunities', 'b')), 'ok'), 'fk', 'nor at an opportunity of org B');
select is(pg_temp.try_as('a_member', format('update public.tasks set opportunity_id = %L where id = %L', pg_temp.row_of('opportunities', 'b'), pg_temp.row_of('tasks', 'a')), 'rows'), 'fk', 'an existing task cannot be re-pointed at org B''s opportunity');
select is(pg_temp.try_as('a_member', format('update public.opportunities set customer_id = %L where id = %L', pg_temp.row_of('customers', 'b'), pg_temp.row_of('opportunities', 'a')), 'rows'), 'fk', 'nor an existing opportunity at org B''s customer');
select is(pg_temp.try_as('g1', format('insert into public.tasks (organization_id, customer_id, title) values (%L, %L, ''link'')', tests.org_id('g1'), pg_temp.row_of('customers', 'g2')), 'ok'), 'fk', 'guest G1 cannot attach G2''s customer to a task in G1''s demo');
select is(pg_temp.try_as('a_member', format('insert into public.tasks (organization_id, assigned_to, title) values (%L, %L, ''link'')', tests.org_id('a'), tests.uid('b_owner')), 'ok'), 'fk', 'a task cannot be assigned to a user outside the organization');
select is(pg_temp.try_as('a_member', format('insert into public.opportunities (organization_id, customer_id, assigned_to, title) values (%L, %L, %L, ''link'')', tests.org_id('a'), pg_temp.row_of('customers', 'a'), tests.uid('b_owner')), 'ok'), 'fk', 'nor an opportunity');
select is(pg_temp.try_as('a_member', format('insert into public.customers (organization_id, assigned_to, display_name) values (%L, %L, ''link'')', tests.org_id('a'), tests.uid('outsider')), 'ok'), 'fk', 'nor a customer, even to a user who belongs nowhere');
select is(pg_temp.try_as('a_member', format('insert into public.tasks (organization_id, customer_id, opportunity_id, assigned_to, title) values (%L, %L, %L, %L, ''control'')', tests.org_id('a'), pg_temp.row_of('customers', 'a'), pg_temp.row_of('opportunities', 'a'), tests.uid('a_admin')), 'ok'), 'ok', 'control: the same task with everything inside org A is accepted');

select * from finish();
rollback;
