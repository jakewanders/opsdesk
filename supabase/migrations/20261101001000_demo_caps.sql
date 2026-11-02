-- SIT-200: database-enforced hard caps for demo workspaces (PRD 8.2).
--
-- Each entity migration attaches the cap to its table in ONE line, after creating the table and its
-- organization_id index:
--
--   select private.attach_demo_cap('public.customers', 'demo_cap_customers');
--
-- The trigger counts the demo organization's rows (ALL rows, archived included, so archiving cannot bypass
-- the cap) and refuses the insert past the cap with OD429 DEMO_CAP, which the API maps to a 429 envelope.
-- Real organizations are never counted. The caps are rows in private.app_limits so tests can lower them.

insert into private.app_limits (key, value, note) values
  ('demo_cap_customers', 50, 'Most customers in one demo workspace.'),
  ('demo_cap_opportunities', 30, 'Most opportunities in one demo workspace.'),
  ('demo_cap_tasks', 75, 'Most tasks in one demo workspace.'),
  ('demo_cap_quotes', 20, 'Most quotes in one demo workspace.'),
  ('demo_cap_activity_events', 300, 'Most (non-essential) activity events in one demo workspace.');

-- SECURITY DEFINER so the kind lookup and the count are not subject to the caller's RLS: a caller who could
-- not see the organization row must not slip past the cap. search_path is pinned.
create or replace function private.enforce_demo_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  cap_key text := tg_argv[0];
  count_filter text := coalesce(tg_argv[1], 'true');
  org uuid := (pg_catalog.to_jsonb(new) ->> 'organization_id')::uuid;
  cap integer;
  current_rows bigint;
begin
  if org is null or not exists (select 1 from public.organizations o where o.id = org and o.kind = 'demo') then
    return new;
  end if;
  cap := private.app_limit(cap_key);
  if cap is null then
    raise exception 'Demo cap "%" is not configured', cap_key;
  end if;

  -- Serialize inserts into this table for this workspace, so two concurrent inserts cannot both pass at cap - 1.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.demo.cap:' || org::text || ':' || tg_relid::text, 0));

  execute pg_catalog.format('select pg_catalog.count(*) from %I.%I where organization_id = $1 and (%s)', tg_table_schema, tg_table_name, count_filter)
    into current_rows using org;
  if current_rows >= cap then
    raise exception using
      errcode = 'OD429',
      message = pg_catalog.format('Demo limit reached for %s. Reset the demo to start over.', pg_catalog.replace(tg_table_name, '_', ' ')),
      detail = 'DEMO_CAP',
      hint = 'retry-after=60';
  end if;
  return new;
end;
$$;

-- One-line attach for an entity migration. `count_filter` (trusted migration text) narrows what counts, for example
-- to leave essential audit events out of the activity cap.
create or replace function private.attach_demo_cap(tbl regclass, cap_key text, count_filter text default 'true')
returns void
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = tbl and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped) then
    raise exception 'Cannot attach a demo cap to %: no organization_id column', tbl;
  end if;
  if not exists (select 1 from private.app_limits l where l.key = cap_key) then
    raise exception 'Cannot attach a demo cap: unknown limit "%"', cap_key;
  end if;
  execute pg_catalog.format(
    'create or replace trigger %I before insert on %s for each row execute function private.enforce_demo_cap(%L, %L)',
    (select c.relname from pg_catalog.pg_class c where c.oid = tbl) || '_demo_cap', tbl, cap_key, count_filter
  );
end;
$$;

revoke all on function private.enforce_demo_cap() from public, anon, authenticated;
revoke all on function private.attach_demo_cap(regclass, text, text) from public, anon, authenticated;
