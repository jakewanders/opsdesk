-- SIT-245: the paginated activity feed (PRD US-07, 7.4).
-- SECURITY DEFINER because profiles are private to their owner and the feed shows WHO acted. It stays tenant-safe the same
-- way public.list_workspace_members does: it answers only a member of the organization (anyone else gets OD404), reads only
-- that organization's events, and resolves an actor's display name only through the organization's own memberships, so a
-- person who is not (or no longer) a member is never named and nothing of another tenant is reachable.
--   p_entity_type / p_entity_id / p_action  exact-match filters
--   p_actor + p_system_only                 one person's events, or only the System's (actor is null)
--   p_from / p_to                           inclusive calendar days in the ORGANIZATION'S time zone
-- Order: created_at, then id, so pages never repeat or skip a row. Uses activity_events_org_created_idx (the default feed)
-- and activity_events_org_entity_idx (an entity's timeline). Returns { total, items }.
create or replace function public.list_activity(
  p_org_id uuid,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_action text default null,
  p_actor uuid default null,
  p_system_only boolean default false,
  p_from date default null,
  p_to date default null,
  p_newest_first boolean default true,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  from_ts timestamptz;
  to_ts timestamptz;
  total bigint;
  items jsonb;
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  select o.timezone into tz from public.organizations o where o.id = p_org_id;
  from_ts := case when p_from is null then null else (p_from::timestamp at time zone tz) end;
  to_ts := case when p_to is null then null else ((p_to + 1)::timestamp at time zone tz) end;

  select pg_catalog.count(*) into total
    from public.activity_events e
   where e.organization_id = p_org_id
     and (p_entity_type is null or e.entity_type = p_entity_type)
     and (p_entity_id is null or e.entity_id = p_entity_id)
     and (p_action is null or e.action = p_action)
     and (p_actor is null or e.actor_user_id = p_actor)
     and (not p_system_only or e.actor_user_id is null)
     and (from_ts is null or e.created_at >= from_ts)
     and (to_ts is null or e.created_at < to_ts);

  -- The direction is one of two constant keywords (never client text), so the ordering can use the index.
  execute pg_catalog.format($q$
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', page.id,
             'entityType', page.entity_type,
             'entityId', page.entity_id,
             'action', page.action,
             'summary', page.summary,
             'actorUserId', page.actor_user_id,
             'actorName', case when page.actor_user_id is null then 'System' else page.member_name end,
             'changes', page.changes,
             'createdAt', page.created_at
           ) order by page.created_at %1$s, page.id %1$s), '[]'::jsonb)
      from (
        select e.*,
               (select coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Member')
                  from public.memberships m
                  join public.profiles p on p.id = m.user_id
                 where m.organization_id = $1 and m.user_id = e.actor_user_id) as member_name
          from public.activity_events e
         where e.organization_id = $1
           and ($2::text is null or e.entity_type = $2)
           and ($3::uuid is null or e.entity_id = $3)
           and ($4::text is null or e.action = $4)
           and ($5::uuid is null or e.actor_user_id = $5)
           and (not $6 or e.actor_user_id is null)
           and ($7::timestamptz is null or e.created_at >= $7)
           and ($8::timestamptz is null or e.created_at < $8)
         order by e.created_at %1$s, e.id %1$s
         limit $9 offset $10
      ) page
  $q$, case when p_newest_first then 'desc' else 'asc' end)
  into items
  using p_org_id, p_entity_type, p_entity_id, p_action, p_actor, p_system_only, from_ts, to_ts, greatest(p_limit, 0), greatest(p_offset, 0);

  return pg_catalog.jsonb_build_object('total', total, 'items', items);
end;
$$;
revoke all on function public.list_activity(uuid, text, uuid, text, uuid, boolean, date, date, boolean, integer, integer) from public, anon;
grant execute on function public.list_activity(uuid, text, uuid, text, uuid, boolean, date, date, boolean, integer, integer) to authenticated;
