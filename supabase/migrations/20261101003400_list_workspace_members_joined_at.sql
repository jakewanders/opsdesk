-- SIT-233: the Members page shows when each person joined. Adds `joined_at` to public.list_workspace_members (still only
-- id, role, display name and join date: no e-mail, no avatar, nothing of another tenant). Same authority as before: only a
-- member of the organization may ask; anyone else gets OD404.
drop function public.list_workspace_members(uuid);
create function public.list_workspace_members(p_org_id uuid)
returns table (user_id uuid, role text, display_name text, joined_at timestamptz)
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
    select m.user_id, m.role, coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Member'), m.joined_at
      from public.memberships m
      left join public.profiles p on p.id = m.user_id
     where m.organization_id = p_org_id
     order by pg_catalog.lower(coalesce(nullif(pg_catalog.btrim(p.display_name), ''), 'Member')), m.user_id;
end;
$$;
revoke all on function public.list_workspace_members(uuid) from public, anon;
grant execute on function public.list_workspace_members(uuid) to authenticated;
