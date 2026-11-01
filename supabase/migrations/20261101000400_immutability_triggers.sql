-- SIT-188: reusable immutability triggers for bookkeeping columns (PRD 6.4, 5.2 items 1 and 4).
--
--   private.prevent_column_change()      generic BEFORE UPDATE trigger: the columns named in the trigger
--                                        arguments may not change (errcode OD403 / IMMUTABLE_COLUMN)
--   private.protect_columns(tbl, cols..) attaches it in one line:  select private.protect_columns('public.t', 'organization_id', 'created_by');
--   private.protect_org_expiry()         organizations.expires_at: only trusted roles / definer code
--   private.set_demo_expiry(org, ts)     the one named path that extends or resets a demo's expiry
--
-- The triggers are SECURITY INVOKER on purpose: `current_user` is then the role that ran the UPDATE
-- (authenticated for an API caller; the function owner inside a SECURITY DEFINER function), which is
-- what the expiry rule needs. They cannot be switched off by a regular role: disabling a trigger needs
-- table ownership.

create or replace function private.prevent_column_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  col text;
  old_row jsonb := pg_catalog.to_jsonb(old);
  new_row jsonb := pg_catalog.to_jsonb(new);
begin
  foreach col in array tg_argv loop
    -- A typo in the trigger arguments would silently protect nothing: fail loudly instead.
    if not (new_row ? col) then
      raise exception 'Protected column "%" does not exist on %.%', col, tg_table_schema, tg_table_name;
    end if;
    if new_row -> col is distinct from old_row -> col then
      -- A referential action (ON DELETE SET NULL on a user FK) runs as a nested trigger and may null the column.
      if new_row -> col = 'null'::jsonb and pg_catalog.pg_trigger_depth() > 1 then
        continue;
      end if;
      raise exception using
        errcode = 'OD403',
        message = 'This field cannot be changed.',
        detail = 'IMMUTABLE_COLUMN',
        hint = col;
    end if;
  end loop;
  return new;
end;
$$;

create or replace function private.protect_columns(tbl regclass, variadic cols text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  col text;
  args text;
begin
  if cols is null or pg_catalog.cardinality(cols) = 0 then
    raise exception 'protect_columns needs at least one column';
  end if;
  foreach col in array cols loop
    if not exists (
      select 1 from pg_catalog.pg_attribute a
      where a.attrelid = tbl and a.attname = col and a.attnum > 0 and not a.attisdropped
    ) then
      raise exception 'Cannot protect "%": no such column on %', col, tbl;
    end if;
  end loop;
  select pg_catalog.string_agg(pg_catalog.quote_literal(c), ', ') into args from pg_catalog.unnest(cols) as c;
  execute pg_catalog.format(
    'create or replace trigger %I before update on %s for each row execute function private.prevent_column_change(%s)',
    (select c.relname from pg_catalog.pg_class c where c.oid = tbl) || '_protect_columns',
    tbl,
    args
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- organizations.expires_at: trusted roles only
-- ---------------------------------------------------------------------------------------------
create or replace function private.protect_org_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.expires_at is distinct from old.expires_at
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using
      errcode = 'OD403',
      message = 'This field cannot be changed.',
      detail = 'IMMUTABLE_COLUMN',
      hint = 'expires_at';
  end if;
  return new;
end;
$$;

create trigger organizations_protect_expiry
  before update on public.organizations
  for each row execute function private.protect_org_expiry();

select private.protect_columns('public.organizations', 'id', 'created_at', 'created_by', 'kind');
select private.protect_columns('public.memberships', 'organization_id', 'user_id', 'joined_at');
select private.protect_columns('public.profiles', 'id', 'created_at');

-- ---------------------------------------------------------------------------------------------
-- The named privileged path for a demo's expiry (bootstrap, reset and tests call this)
-- ---------------------------------------------------------------------------------------------
create or replace function private.set_demo_expiry(org_id uuid, new_expires_at timestamptz)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  result timestamptz;
begin
  if new_expires_at is null then
    raise exception using errcode = 'OD422', message = 'A demo workspace needs an expiry time.', detail = 'EXPIRY_REQUIRED';
  end if;
  update public.organizations
     set expires_at = new_expires_at
   where id = org_id and kind = 'demo'
  returning expires_at into result;
  if not found then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  return result;
end;
$$;

revoke all on function private.prevent_column_change() from public, anon, authenticated;
revoke all on function private.protect_columns(regclass, text[]) from public, anon, authenticated;
revoke all on function private.protect_org_expiry() from public, anon, authenticated;
revoke all on function private.set_demo_expiry(uuid, timestamptz) from public, anon, authenticated;
grant execute on function private.set_demo_expiry(uuid, timestamptz) to service_role;
