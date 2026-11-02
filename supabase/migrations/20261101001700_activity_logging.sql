-- SIT-201: the transactional activity logging mechanism (PRD 6.5, US-07).
--
-- A successful change and its event commit together or not at all, because the event is written by an AFTER trigger (or by
-- the RPC that made the change) inside the same transaction. Nothing here is callable by a browser role.
--
-- For an entity migration (customers, opportunities, tasks, quotes), one call after creating the table:
--
--   select private.attach_activity_log('public.customers', 'customer', 'name',
--     array['name', 'status', 'owner_id'],     -- SAFE fields: logged with old and new value
--     array['notes', 'email', 'phone'],        -- CONTENT fields: logged as "changed", never with their value
--     'archived_at');                          -- archive column (null when active), or null
--
-- Named transitions (stage change, complete, send) call private.log_activity from their RPC with their own summary.

-- ---------------------------------------------------------------------------------------------
-- Who did it. System mode is switched on (transaction-local) by the seed runner, so seeded rows carry no actor.
-- ---------------------------------------------------------------------------------------------
create or replace function private.activity_system_mode()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(pg_catalog.current_setting('opsdesk.actor_mode', true), '') = 'system' $$;

create or replace function private.activity_actor_id()
returns uuid
language sql
stable
set search_path = ''
as $$ select case when private.activity_system_mode() then null else auth.uid() end $$;

create or replace function private.activity_actor_name()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select nullif(pg_catalog.btrim(p.display_name), '') from public.profiles p where p.id = private.activity_actor_id()),
    case when private.activity_actor_id() is null then 'System' else 'Someone' end
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- The whitelist. Whatever a caller passes, `changes` ends up as { field: { old, new } } for plain, safe fields only, with
-- short scalar values, plus `_content_changed: [field names]` for anything that is free text, contact data or a secret.
-- ---------------------------------------------------------------------------------------------
create or replace function private.activity_safe_scalar(v jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case pg_catalog.jsonb_typeof(v)
    when 'string' then pg_catalog.to_jsonb(pg_catalog.left(v #>> '{}', 120))
    when 'number' then v
    when 'boolean' then v
    when 'null' then v
    else '"[complex]"'::jsonb
  end
$$;

create or replace function private.sanitize_activity_changes(changes jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  result jsonb := '{}'::jsonb;
  content text[] := '{}';
  k text;
  v jsonb;
begin
  if changes is null or pg_catalog.jsonb_typeof(changes) <> 'object' then
    return '{}'::jsonb;
  end if;
  for k, v in select e.key, e.value from pg_catalog.jsonb_each(changes) e loop
    if k = '_content_changed' then
      if pg_catalog.jsonb_typeof(v) = 'array' then
        content := content || array(select pg_catalog.left(x, 60) from pg_catalog.jsonb_array_elements_text(v) x where x ~ '^[a-z][a-z0-9_]{0,59}$' limit 20);
      end if;
      continue;
    end if;
    if k !~ '^[a-z][a-z0-9_]{0,59}$' then
      continue; -- not a plain column name: dropped
    end if;
    if k ~* '^(notes?|description|body|content|comments?|memo|message|text|html|raw|payload|details?|email|e_mail|phone|mobile|address|street|postcode|zip)$|passw|token|secret|api_?key|credential|authoriz|cookie|session|jwt|signature|otp|private_?key|invit' then
      content := content || k; -- free text, contact data or a secret: recorded as "changed", without its value
      continue;
    end if;
    if pg_catalog.jsonb_typeof(v) = 'object' and (v ? 'old' or v ? 'new') then
      result := result || pg_catalog.jsonb_build_object(
        k, pg_catalog.jsonb_build_object('old', private.activity_safe_scalar(v -> 'old'), 'new', private.activity_safe_scalar(v -> 'new'))
      );
    end if;
  end loop;
  if pg_catalog.cardinality(content) > 0 then
    result := result || pg_catalog.jsonb_build_object(
      '_content_changed',
      pg_catalog.to_jsonb(array(select distinct x from pg_catalog.unnest(content) x order by x limit 20))
    );
  end if;
  return result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The writer. SECURITY DEFINER (runs as the table owner, so it can insert where no API role can), no client grant.
-- `occurred_at` is honoured only in system mode (the seed back-dates its history); otherwise the event is stamped with the clock
-- time (not the transaction start, so several events of one transaction keep their order).
-- ---------------------------------------------------------------------------------------------
create or replace function private.log_activity(
  org_id uuid,
  etype text,
  eid uuid,
  act text,
  summary text,
  changes jsonb default '{}'::jsonb,
  occurred_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_summary text := pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(summary, ''), '[\x00-\x1f\x7f]+', ' ', 'g'));
  new_id uuid;
begin
  if clean_summary = '' then
    raise exception 'An activity event needs a summary';
  end if;
  insert into public.activity_events (organization_id, entity_type, entity_id, action, actor_user_id, summary, changes, created_at)
  values (
    org_id, etype, eid, act, private.activity_actor_id(),
    pg_catalog.left(clean_summary, 300),
    private.sanitize_activity_changes(changes),
    -- clock_timestamp, not now(): events of one transaction keep their order
    case when private.activity_system_mode() and occurred_at is not null then occurred_at else pg_catalog.clock_timestamp() end
  )
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- The generic row trigger. Arguments: entity type, name column, safe fields (csv), content fields (csv), archive column.
--   INSERT                          -> 'created'
--   archive column null -> value    -> 'archived';  value -> null -> 'restored'
--   a safe or content field changed -> 'updated' (safe: old and new; content: field name only)
--   anything else (touching only updated_at, rewriting a value with itself...) -> no event
-- ---------------------------------------------------------------------------------------------
create or replace function private.log_entity_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  etype text := tg_argv[0];
  name_col text := tg_argv[1];
  safe text[] := pg_catalog.string_to_array(coalesce(tg_argv[2], ''), ',');
  content text[] := pg_catalog.string_to_array(coalesce(nullif(tg_argv[3], ''), ''), ',');
  arch text := nullif(tg_argv[4], '');
  new_j jsonb := pg_catalog.to_jsonb(new);
  old_j jsonb;
  org uuid := (new_j ->> 'organization_id')::uuid;
  eid uuid := (new_j ->> 'id')::uuid;
  nm text := pg_catalog.left(coalesce(new_j ->> name_col, ''), 80);
  who text := private.activity_actor_name();
  label text := case when nm = '' then etype else pg_catalog.format('%s "%s"', etype, nm) end;
  diff jsonb := '{}'::jsonb;
  touched_content text[] := '{}';
  fields text[];
  f text;
begin
  if tg_op = 'INSERT' then
    perform private.log_activity(org, etype, eid, 'created', pg_catalog.format('%s created %s', who, label));
    return null;
  end if;

  old_j := pg_catalog.to_jsonb(old);

  if arch is not null and (old_j -> arch) is distinct from (new_j -> arch) then
    if (old_j -> arch) = 'null'::jsonb and (new_j -> arch) <> 'null'::jsonb then
      perform private.log_activity(org, etype, eid, 'archived', pg_catalog.format('%s archived %s', who, label));
    elsif (old_j -> arch) <> 'null'::jsonb and (new_j -> arch) = 'null'::jsonb then
      perform private.log_activity(org, etype, eid, 'restored', pg_catalog.format('%s restored %s', who, label));
    end if;
  end if;

  foreach f in array safe loop
    if f <> '' and (old_j -> f) is distinct from (new_j -> f) then
      diff := diff || pg_catalog.jsonb_build_object(f, pg_catalog.jsonb_build_object('old', old_j -> f, 'new', new_j -> f));
    end if;
  end loop;
  foreach f in array content loop
    if f <> '' and (old_j -> f) is distinct from (new_j -> f) then
      touched_content := touched_content || f;
    end if;
  end loop;

  if diff <> '{}'::jsonb or pg_catalog.cardinality(touched_content) > 0 then
    fields := array(select k from pg_catalog.jsonb_object_keys(diff) k order by k) || touched_content;
    perform private.log_activity(
      org, etype, eid, 'updated',
      pg_catalog.format('%s updated %s (%s)', who, label, pg_catalog.array_to_string(fields, ', ')),
      case when pg_catalog.cardinality(touched_content) > 0 then diff || pg_catalog.jsonb_build_object('_content_changed', pg_catalog.to_jsonb(touched_content)) else diff end
    );
  end if;
  return null;
end;
$$;

-- One-line attach for an entity migration (trusted migration text).
create or replace function private.attach_activity_log(
  tbl regclass,
  etype text,
  name_column text,
  safe_fields text[],
  content_fields text[] default '{}',
  archive_column text default null
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  col text;
begin
  foreach col in array array['id', 'organization_id', name_column] || safe_fields || content_fields || coalesce(array[archive_column], '{}') loop
    if col is not null and not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = tbl and a.attname = col and a.attnum > 0 and not a.attisdropped) then
      raise exception 'Cannot attach activity logging to %: no column "%"', tbl, col;
    end if;
  end loop;
  execute pg_catalog.format(
    'create or replace trigger %I after insert or update on %s for each row execute function private.log_entity_change(%L, %L, %L, %L, %L)',
    (select c.relname from pg_catalog.pg_class c where c.oid = tbl) || '_activity_log', tbl,
    etype, name_column, pg_catalog.array_to_string(safe_fields, ','), pg_catalog.array_to_string(content_fields, ','), coalesce(archive_column, '')
  );
end;
$$;

-- No API role may run any of it.
revoke all on function
  private.activity_system_mode(), private.activity_actor_id(), private.activity_actor_name(),
  private.activity_safe_scalar(jsonb), private.sanitize_activity_changes(jsonb),
  private.log_activity(uuid, text, uuid, text, text, jsonb, timestamptz),
  private.log_entity_change(),
  private.attach_activity_log(regclass, text, text, text[], text[], text)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Seeding is the System: switch the actor off for the seed runner's transaction, then restore it. (The runner is
-- otherwise unchanged from SIT-192/SIT-205.)
-- ---------------------------------------------------------------------------------------------
create or replace function private.seed_demo_workspace(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  org_kind text;
  current_version integer := private.demo_seed_version();
  seeder record;
  previous_mode text := coalesce(pg_catalog.current_setting('opsdesk.actor_mode', true), '');
begin
  select o.kind into org_kind from public.organizations o where o.id = org_id;
  if org_kind is null then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  if org_kind <> 'demo' then
    raise exception using errcode = 'OD403', message = 'Only demo workspaces can be seeded.', detail = 'NOT_A_DEMO';
  end if;
  if not exists (select 1 from public.demo_workspaces w where w.organization_id = org_id) then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  -- Idempotent: the marker is the stored seed version.
  if exists (select 1 from public.demo_workspaces w where w.organization_id = org_id and w.seed_version >= current_version) then
    return;
  end if;

  perform pg_catalog.set_config('opsdesk.actor_mode', 'system', true);
  for seeder in select s.fn from private.demo_seeders s order by s.position loop
    execute pg_catalog.format('select %s($1)', seeder.fn::regproc::text) using org_id;
  end loop;
  perform pg_catalog.set_config('opsdesk.actor_mode', previous_mode, true);

  perform private.record_demo_seed(org_id, current_version);
end;
$$;
