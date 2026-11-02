-- SIT-186: a no-data liveness probe for GET /api/health. It touches no table, so it proves the database accepts a
-- connection and runs a query, and returns nothing a visitor could use. Callable by anyone, by design.
create or replace function public.health_ping()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select true $$;

revoke all on function public.health_ping() from public;
grant execute on function public.health_ping() to anon, authenticated;
comment on function public.health_ping() is 'Liveness probe for /api/health: returns true, reads nothing.';
