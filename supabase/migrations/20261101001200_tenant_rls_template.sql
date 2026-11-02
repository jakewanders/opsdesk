-- SIT-206: the standard row-level security for a business table, in one call (the template SIT-194 promised).
--
-- Every tenant table (customers, opportunities, tasks, quotes, activity...) calls this right after creating the
-- table and its organization_id index:
--
--   select private.attach_tenant_rls('public.customers');
--
-- Reads: members of the organization. Writes (insert, update, delete): owner, admin and member of an organization
-- whose data is WRITABLE, which for a demo means not past `expires_at` (private.can_write -> org_is_writable). So an
-- expired demo rejects every insert, update and delete at the database, even for a client calling the Supabase
-- SDK directly. Viewers read only. `anon` gets nothing. A table-specific rule (for example an admin-only column)
-- is added as an extra RESTRICTIVE policy by the entity migration, never by loosening these.

create or replace function private.attach_tenant_rls(tbl regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
  rel_name text := (select c.relname from pg_catalog.pg_class c where c.oid = tbl);
begin
  if not exists (select 1 from pg_catalog.pg_attribute a where a.attrelid = tbl and a.attname = 'organization_id' and a.attnum > 0 and not a.attisdropped) then
    raise exception 'Cannot attach tenant RLS to %: no organization_id column', tbl;
  end if;

  execute pg_catalog.format('alter table %s enable row level security', tbl);
  execute pg_catalog.format('revoke all on table %s from public, anon, authenticated', tbl);
  execute pg_catalog.format('grant select, insert, update, delete on table %s to authenticated', tbl);

  execute pg_catalog.format('drop policy if exists %I on %s', rel_name || '_select_member', tbl);
  execute pg_catalog.format('create policy %I on %s for select to authenticated using (private.is_member(organization_id))', rel_name || '_select_member', tbl);

  execute pg_catalog.format('drop policy if exists %I on %s', rel_name || '_insert_writer', tbl);
  execute pg_catalog.format('create policy %I on %s for insert to authenticated with check (private.can_write(organization_id))', rel_name || '_insert_writer', tbl);

  execute pg_catalog.format('drop policy if exists %I on %s', rel_name || '_update_writer', tbl);
  execute pg_catalog.format('create policy %I on %s for update to authenticated using (private.can_write(organization_id)) with check (private.can_write(organization_id))', rel_name || '_update_writer', tbl);

  execute pg_catalog.format('drop policy if exists %I on %s', rel_name || '_delete_writer', tbl);
  execute pg_catalog.format('create policy %I on %s for delete to authenticated using (private.can_write(organization_id))', rel_name || '_delete_writer', tbl);
end;
$$;
revoke all on function private.attach_tenant_rls(regclass) from public, anon, authenticated;
