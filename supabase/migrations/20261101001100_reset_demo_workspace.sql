-- SIT-205: reset_demo_workspace(org_id): a guest restores the exact seed state of THEIR OWN demo.
--
-- The seed registry (SIT-192) learns how to clear: each seeder may register a clear function next to its seed
-- function, and a reset runs the clear functions in REVERSE position order (children before parents), then re-seeds.
--   select private.register_demo_seeder('customers', 10, 'private.seed_customers(uuid)'::regprocedure, 1,
--                                       'private.clear_customers(uuid)'::regprocedure);
-- A clear function deletes only `where organization_id = org_id`. The activity table registers one that uses the
-- privileged path its append-only trigger allows (SIT-195).

alter table private.demo_seeders add column clear_fn regprocedure;

drop function private.register_demo_seeder(text, integer, regprocedure, integer);
create or replace function private.register_demo_seeder(
  seeder_name text, seeder_position integer, seeder_fn regprocedure, seeder_version integer default 1, seeder_clear_fn regprocedure default null
)
returns void
language sql
set search_path = ''
as $$
  insert into private.demo_seeders (name, position, fn, version, clear_fn)
  values (seeder_name, seeder_position, seeder_fn, seeder_version, seeder_clear_fn)
  on conflict (name) do update
    set position = excluded.position, fn = excluded.fn, version = excluded.version, clear_fn = excluded.clear_fn;
$$;
revoke all on function private.register_demo_seeder(text, integer, regprocedure, integer, regprocedure) from public, anon, authenticated;

-- Deletes the demo business data of ONE demo organization by running the registered clear functions, last seeder first.
create or replace function private.clear_demo_data(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  seeder record;
begin
  if not exists (select 1 from public.organizations o where o.id = org_id and o.kind = 'demo') then
    raise exception using errcode = 'OD403', message = 'Only demo workspaces can be cleared.', detail = 'NOT_A_DEMO';
  end if;
  for seeder in select s.clear_fn from private.demo_seeders s where s.clear_fn is not null order by s.position desc loop
    execute pg_catalog.format('select %s($1)', seeder.clear_fn::regproc::text) using org_id;
  end loop;
end;
$$;
revoke all on function private.clear_demo_data(uuid) from public, anon, authenticated;
grant execute on function private.clear_demo_data(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- public.reset_demo_workspace(org_id)
-- ---------------------------------------------------------------------------------------------
-- The caller must be an anonymous guest who OWNS this demo (their demo_workspaces row). Anything else (another
-- guest's organization, a real organization, an unknown id) gets the same "not found", so existence never leaks.
-- Their own EXPIRED demo is refused with DEMO_EXPIRED (it is theirs, so no leak). One transaction: claim the
-- throttle, clear the data, clear the seed marker, re-seed. The organization, its owner membership and
-- `expires_at` are not touched (a reset never extends the 24 hours). A failure anywhere rolls back everything,
-- including the throttle claim, so a failed reset neither loses data nor uses up the minute.
create or replace function public.reset_demo_workspace(org_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  guest boolean;
  owned_expiry timestamptz;
  claimed timestamptz;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Start the demo from the demo page.', detail = 'NOT_SIGNED_IN';
  end if;
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if not private.is_anonymous() or guest is distinct from true then
    raise exception using errcode = 'OD403', message = 'Only guest visitors have a demo to reset.', detail = 'GUEST_ONLY';
  end if;

  -- Serialize resets of this workspace (a double click, two tabs).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.demo.reset:' || coalesce(org_id::text, ''), 0));

  select o.expires_at into owned_expiry
    from public.demo_workspaces w
    join public.organizations o on o.id = w.organization_id and o.kind = 'demo'
   where w.organization_id = org_id and w.user_id = uid;
  if not found then
    raise exception using errcode = 'OD404', message = 'That demo workspace was not found.', detail = 'DEMO_NOT_FOUND';
  end if;
  if owned_expiry is null or owned_expiry <= pg_catalog.now() then
    raise exception using errcode = 'OD403', message = 'This demo has expired. Start a new one to keep exploring.', detail = 'DEMO_EXPIRED';
  end if;

  claimed := private.begin_demo_reset(org_id);      -- OD429 with a retry-after hint when reset less than a minute ago
  perform private.clear_demo_data(org_id);
  perform private.clear_demo_seed_marker(org_id);
  perform private.seed_demo_workspace(org_id);

  return pg_catalog.jsonb_build_object(
    'organization_id', org_id,
    'reset_at', claimed,
    'expires_at', owned_expiry,
    'seed_version', (select w.seed_version from public.demo_workspaces w where w.organization_id = org_id)
  );
end;
$$;

revoke all on function public.reset_demo_workspace(uuid) from public, anon;
grant execute on function public.reset_demo_workspace(uuid) to authenticated, service_role;
comment on function public.reset_demo_workspace(uuid) is
  'Restores the seed state of the calling guest''s own demo workspace. One reset per minute; never extends the expiry.';
