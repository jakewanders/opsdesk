-- SIT-225: the people in a workspace, for owner / assignee pickers.
-- Profiles are readable only by their owner (row level security), so a member cannot read a teammate's display name
-- directly. This function is the one narrow way: SECURITY DEFINER, pinned search_path, and it answers only a MEMBER of
-- the organization (anyone else, including a user of another tenant, gets the same OD404 as an unknown workspace).
-- It returns the user id, the role and the display name, nothing else (no e-mail, no avatar, no other tenants).
create or replace function public.list_workspace_members(p_org_id uuid)
returns table (user_id uuid, role text, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_member(p_org_id) then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  return query
    select m.user_id, m.role, coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Member')
      from public.memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org_id
     order by pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Member')), m.user_id;
end;
$$;
revoke all on function public.list_workspace_members(uuid) from public, anon;
grant execute on function public.list_workspace_members(uuid) to authenticated;
