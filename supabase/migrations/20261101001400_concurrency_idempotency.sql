-- SIT-183: optimistic concurrency and idempotency keys (PRD 7.5).
--
-- Concurrency: CRM entities compare `updated_at` (maintained by private.set_updated_at); entities that need a
-- monotonic counter (quotes) carry an integer `version` maintained by private.bump_version().
-- Idempotency: private.idempotency_keys, reachable only through the three functions below.

-- ---------------------------------------------------------------------------------------------
-- Version counter for entities that use `version` instead of `updated_at` comparison
-- ---------------------------------------------------------------------------------------------
create or replace function private.bump_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;   -- the client cannot choose it: any value it sends is overwritten
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.bump_version() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Idempotency store
-- ---------------------------------------------------------------------------------------------
create table private.idempotency_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  route text not null check (length(route) between 1 and 200),
  key text not null check (key ~ '^[A-Za-z0-9_-]{8,128}$'),
  request_hash text not null check (length(request_hash) between 8 and 128),
  state text not null default 'in_progress' check (state in ('in_progress', 'done')),
  response_status integer check (response_status between 200 and 599),
  response_body jsonb check (response_body is null or pg_catalog.octet_length(response_body::text) <= 100000),
  created_at timestamptz not null default pg_catalog.now(),
  expires_at timestamptz not null default pg_catalog.now() + interval '24 hours',
  primary key (user_id, route, key),
  check (state = 'in_progress' or response_status is not null)
);
create index idempotency_keys_expires_at_idx on private.idempotency_keys (expires_at);
alter table private.idempotency_keys enable row level security;   -- no policies: closed to every API role
revoke all on private.idempotency_keys from public, anon, authenticated;

-- begin: claim the key, or report what already happened.
--   {state:'new'}                         the caller owns the key and must do the work
--   {state:'replay', status, body}        finished earlier with the same request: return the stored result
--   {state:'in_progress'}                 another request with this key is still running
--   {state:'mismatch'}                    the key was used for a different request
create or replace function public.idempotency_begin(p_route text, p_key text, p_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  existing private.idempotency_keys;
  claimed boolean;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to continue.';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception using errcode = 'OD422', message = 'The Idempotency-Key must be 8 to 128 letters, digits, dashes or underscores.', detail = 'IDEMPOTENCY_KEY_INVALID';
  end if;
  if p_route is null or p_route = '' or p_hash is null or p_hash = '' then
    raise exception using errcode = 'OD422', message = 'Invalid idempotency request.', detail = 'IDEMPOTENCY_KEY_INVALID';
  end if;

  -- an expired key, or a claim abandoned by a crashed request (2 minutes), no longer counts
  delete from private.idempotency_keys k
   where k.user_id = uid and k.route = p_route and k.key = p_key
     and (k.expires_at < pg_catalog.now() or (k.state = 'in_progress' and k.created_at < pg_catalog.now() - interval '2 minutes'));

  insert into private.idempotency_keys (user_id, route, key, request_hash)
  values (uid, p_route, p_key, p_hash)
  on conflict do nothing
  returning true into claimed;
  if claimed then
    return pg_catalog.jsonb_build_object('state', 'new');
  end if;

  select * into existing from private.idempotency_keys k where k.user_id = uid and k.route = p_route and k.key = p_key;
  if not found then
    return pg_catalog.jsonb_build_object('state', 'in_progress');   -- removed between the two statements: ask the caller to retry
  end if;
  if existing.request_hash <> p_hash then
    return pg_catalog.jsonb_build_object('state', 'mismatch');
  end if;
  if existing.state = 'done' then
    return pg_catalog.jsonb_build_object('state', 'replay', 'status', existing.response_status, 'body', existing.response_body);
  end if;
  return pg_catalog.jsonb_build_object('state', 'in_progress');
end;
$$;

-- complete: store the result so a replay returns it. Only the claim's own owner can complete it.
create or replace function public.idempotency_complete(p_route text, p_key text, p_status integer, p_body jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  done integer;
begin
  update private.idempotency_keys k
     set state = 'done', response_status = p_status, response_body = p_body
   where k.user_id = auth.uid() and k.route = p_route and k.key = p_key and k.state = 'in_progress';
  get diagnostics done = row_count;
  return done = 1;
end;
$$;

-- abandon: the work failed, so the same key may be tried again.
create or replace function public.idempotency_abandon(p_route text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  gone integer;
begin
  delete from private.idempotency_keys k
   where k.user_id = auth.uid() and k.route = p_route and k.key = p_key and k.state = 'in_progress';
  get diagnostics gone = row_count;
  return gone = 1;
end;
$$;

revoke all on function public.idempotency_begin(text, text, text), public.idempotency_complete(text, text, integer, jsonb),
  public.idempotency_abandon(text, text) from public, anon;
grant execute on function public.idempotency_begin(text, text, text), public.idempotency_complete(text, text, integer, jsonb),
  public.idempotency_abandon(text, text) to authenticated;
