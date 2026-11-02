-- SIT-229: fix for SIT-220. `private.prepare_task()` runs as the calling role (it is an ordinary BEFORE trigger) and asked
-- `private.activity_system_mode()` whether the seed runner was calling, but no API role may execute that helper, so any
-- insert as done or change to done by a member failed with "permission denied for function" (surfaced as 403). The
-- test files missed it because they inserted as the superuser. The trigger now reads the transaction setting itself.
create or replace function private.prepare_task()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title := pg_catalog.btrim(new.title);
  new.description := nullif(pg_catalog.btrim(new.description), '');
  if new.status <> 'done' then
    new.completed_at := null;
  elsif tg_op = 'UPDATE' and old.status = 'done' then
    new.completed_at := old.completed_at;
  elsif not (coalesce(pg_catalog.current_setting('opsdesk.actor_mode', true), '') = 'system' and new.completed_at is not null) then
    new.completed_at := pg_catalog.now();
  end if;
  return new;
end;
$$;
revoke all on function private.prepare_task() from public, anon, authenticated;
