-- SIT-199: bootstrap_demo_workspace(): the secure core of the public demo (PRD 6.5, 8.1 steps 3 and 4).
--
-- One call creates or restores the CALLER's isolated demo workspace and seeds it.
--  * No parameters. The owner is auth.uid(); the organization id, kind, expiry and name are chosen here.
--  * Anonymous guests only: the signed JWT claim AND the auth.users row must both say so.
--  * Idempotent: a caller with a live demo gets it back unchanged (same id, same expiry, no new seed rows).
--  * Race safe: a per-user advisory lock serializes calls; the unique demo_workspaces.user_id is the arbiter.
--  * A caller whose previous demo expired gets it cleaned up (only their own) and a fresh one.
--  * A global ceiling on active demos protects the free tier (429-mapped).
--
-- It lives in `public` only because PostgREST exposes that schema and the server route calls it with the
-- caller's own session; EXECUTE is granted to `authenticated` alone, and the checks are inside the function.

-- Tunable limits (no client access). Update with the service role, for example:
--   update private.demo_limits set value = 500 where key = 'max_active_demos';
create table private.demo_limits (
  key text primary key,
  value integer not null check (value >= 0),
  note text not null
);
revoke all on table private.demo_limits from public, anon, authenticated;
insert into private.demo_limits (key, value, note) values
  ('max_active_demos', 200, 'Most simultaneously active (unexpired) demo workspaces; protects the free tier.');

create or replace function private.demo_limit(limit_key text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$ select l.value from private.demo_limits l where l.key = limit_key $$;
revoke all on function private.demo_limit(text) from public, anon, authenticated;
grant execute on function private.demo_limit(text) to service_role;

create or replace function public.bootstrap_demo_workspace()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  existing_org uuid;
  existing_expiry timestamptz;
  new_org uuid;
  new_expiry timestamptz;
  active_demos integer;
  ceiling integer := coalesce(private.demo_limit('max_active_demos'), 200);
  guest boolean;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Start the demo from the demo page.', detail = 'NOT_SIGNED_IN';
  end if;

  -- Anonymous only: the signed claim and the stored user must agree. A registered user never gets a demo here.
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if not private.is_anonymous() or guest is distinct from true then
    raise exception using errcode = 'OD403', message = 'The live demo is for guest visitors. Sign out to try it.', detail = 'GUEST_ONLY';
  end if;

  -- Serialize this user's calls: two tabs, a retry, or a double click all queue here.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.demo.bootstrap:' || uid::text, 0));

  select w.organization_id, o.expires_at into existing_org, existing_expiry
    from public.demo_workspaces w
    join public.organizations o on o.id = w.organization_id
   where w.user_id = uid;

  if existing_org is not null then
    if existing_expiry > pg_catalog.now() then
      return pg_catalog.jsonb_build_object(
        'organization_id', existing_org,
        'expires_at', existing_expiry,
        'created', false,
        'seed_version', (select w.seed_version from public.demo_workspaces w where w.organization_id = existing_org)
      );
    end if;
    -- The caller's own expired demo: remove it (cascades its mapping and data), then start fresh.
    delete from public.organizations where id = existing_org and kind = 'demo';
  end if;

  select pg_catalog.count(*) into active_demos
    from public.organizations o where o.kind = 'demo' and o.expires_at > pg_catalog.now();
  if active_demos >= ceiling then
    raise exception using
      errcode = 'OD429',
      message = 'The demo is very busy right now. Please try again in a few minutes.',
      detail = 'DEMO_CAPACITY',
      hint = 'retry-after=300';
  end if;

  new_expiry := pg_catalog.now() + private.demo_ttl();
  insert into public.organizations (name, kind, expires_at, created_by)
  values ('Demo Workspace', 'demo', new_expiry, uid)
  returning id into new_org;

  insert into public.memberships (organization_id, user_id, role) values (new_org, uid, 'owner');
  update public.profiles set display_name = 'Demo Owner' where id = uid;

  perform private.register_demo_workspace(new_org, uid);
  perform private.seed_demo_workspace(new_org);

  return pg_catalog.jsonb_build_object(
    'organization_id', new_org,
    'expires_at', new_expiry,
    'created', true,
    'seed_version', private.demo_seed_version()
  );
end;
$$;

revoke all on function public.bootstrap_demo_workspace() from public, anon;
grant execute on function public.bootstrap_demo_workspace() to authenticated, service_role;
comment on function public.bootstrap_demo_workspace() is
  'Creates or returns the calling guest''s demo workspace. No parameters; anonymous users only; idempotent and race safe.';
