-- SIT-202: the ONLY write paths for invitations and for roles and membership (PRD 6.5, US-09, 5.2 item 4).
-- Privilege escalation lives or dies here, so every function:
--   * is SECURITY DEFINER with a pinned empty search_path, EXECUTE for `authenticated` only (never anon, never PUBLIC);
--   * takes NO actor parameter: the actor is auth.uid(), and it must be a REGISTERED user (not an anonymous guest: the
--     signed claim and the stored user must both say so);
--   * checks the actor's role in the organization itself, whatever the caller says, and works only on REAL organizations.
-- Error codes: OD403 not allowed, OD404 workspace/person not found (a non-member gets the same answer as an unknown id),
-- OD409 conflict (last owner, an open invitation), OD422 invalid input, OD429 limit.

insert into private.app_limits (key, value, note) values
  ('max_open_invitations_per_org', 100, 'Most open (not accepted, not revoked) invitations one workspace may hold.'),
  ('invitation_redeem_attempts_per_15_min', 10, 'Most invitation redemption attempts per user in 15 minutes (failed ones count).');

-- Redemption attempts must survive a failed attempt, so redeem_invitation answers with a result object instead of raising;
-- this table records each attempt in the same transaction that returns it.
create table private.invitation_redeem_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index invitation_redeem_attempts_user_idx on private.invitation_redeem_attempts (user_id, attempted_at desc);
revoke all on table private.invitation_redeem_attempts from public, anon, authenticated;

-- The registered user making this call, or an error.
create or replace function private.require_registered_actor()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  guest boolean;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to continue.', detail = 'NOT_SIGNED_IN';
  end if;
  select u.is_anonymous into guest from auth.users u where u.id = uid;
  if private.is_anonymous() or guest is distinct from false then
    raise exception using errcode = 'OD403', message = 'Create an account to manage members. Guests cannot.', detail = 'ACCOUNT_REQUIRED';
  end if;
  return uid;
end;
$$;

-- The caller's role in an organization, which must be a REAL one; a non-member (or an unknown id, or a demo) gets OD404.
create or replace function private.actor_role_in_real_org(org_id uuid, uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  found_role text;
begin
  select m.role into found_role
    from public.memberships m
    join public.organizations o on o.id = m.organization_id and o.kind = 'real'
   where m.organization_id = org_id and m.user_id = uid;
  if found_role is null then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  return found_role;
end;
$$;

-- Compares two strings in time that does not depend on where they first differ.
create or replace function private.constant_time_equals(a text, b text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  x bytea := pg_catalog.convert_to(coalesce(a, ''), 'utf8');
  y bytea := pg_catalog.convert_to(coalesce(b, ''), 'utf8');
  diff integer := pg_catalog.length(x) # pg_catalog.length(y);
  i integer;
begin
  for i in 0 .. greatest(pg_catalog.length(x), pg_catalog.length(y)) - 1 loop
    diff := diff | ((case when i < pg_catalog.length(x) then pg_catalog.get_byte(x, i) else 0 end) # (case when i < pg_catalog.length(y) then pg_catalog.get_byte(y, i) else 0 end));
  end loop;
  return diff = 0;
end;
$$;

revoke all on function private.require_registered_actor(), private.actor_role_in_real_org(uuid, uuid), private.constant_time_equals(text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- create_invitation(org_id, email, role) -> { id, token, expiresAt }
-- ---------------------------------------------------------------------------------------------
-- Owners and admins invite someone as admin, member or viewer (never owner). Only the SHA-256 of a random 256-bit token is
-- stored; the plaintext comes back ONCE in this result, for the "Copy invite link" button.
create or replace function public.create_invitation(p_org_id uuid, p_email text, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_registered_actor();
  caller_role text := private.actor_role_in_real_org(p_org_id, uid);
  clean_email text := pg_catalog.lower(pg_catalog.btrim(normalize(coalesce(p_email, ''), nfc)));
  token text;
  new_id uuid;
  expires timestamptz;
begin
  if caller_role not in ('owner', 'admin') then
    raise exception using errcode = 'OD403', message = 'You do not have permission to invite people to this workspace.', detail = 'FORBIDDEN';
  end if;
  if p_role is null or p_role not in ('admin', 'member', 'viewer') then
    raise exception using errcode = 'OD422', message = 'Choose Admin, Member or Viewer. Owners cannot be invited.', detail = 'INVALID_ROLE';
  end if;
  if pg_catalog.char_length(clean_email) not between 3 and 254 or clean_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or clean_email ~ '[[:cntrl:]]' then
    raise exception using errcode = 'OD422', message = 'Enter a valid email address.', detail = 'INVALID_EMAIL';
  end if;

  -- One writer at a time per workspace, so the limit and the one-open-invitation rule cannot be raced past.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('opsdesk.invite:' || p_org_id::text, 0));

  if exists (
    select 1 from public.memberships m join auth.users u on u.id = m.user_id
     where m.organization_id = p_org_id and pg_catalog.lower(u.email) = clean_email
  ) then
    raise exception using errcode = 'OD409', message = 'That person is already a member of this workspace.', detail = 'ALREADY_MEMBER';
  end if;

  -- An expired invitation that was never answered is closed here, so it does not block inviting the address again.
  update public.invitations i set revoked_at = now()
   where i.organization_id = p_org_id and i.email_normalized = clean_email
     and i.accepted_at is null and i.revoked_at is null and i.expires_at <= now();
  if exists (select 1 from public.invitations i where i.organization_id = p_org_id and i.email_normalized = clean_email and i.accepted_at is null and i.revoked_at is null) then
    raise exception using errcode = 'OD409', message = 'An invitation for that address is already open. Revoke it to send a new one.', detail = 'INVITATION_OPEN';
  end if;
  if (select pg_catalog.count(*) from public.invitations i where i.organization_id = p_org_id and i.accepted_at is null and i.revoked_at is null)
       >= coalesce(private.app_limit('max_open_invitations_per_org'), 100) then
    raise exception using errcode = 'OD429', message = 'This workspace has too many open invitations. Revoke some first.', detail = 'INVITATION_LIMIT';
  end if;

  -- 256 random bits as 64 hex characters (two version-4 UUIDs from the server's CSPRNG, without the dashes)
  token := pg_catalog.replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.invitations (organization_id, email_normalized, role, token_hash, invited_by)
  values (p_org_id, clean_email, p_role, pg_catalog.encode(sha256(pg_catalog.convert_to(token, 'utf8')), 'hex'), uid)
  returning id, expires_at into new_id, expires;

  return pg_catalog.jsonb_build_object('id', new_id, 'token', token, 'expiresAt', expires);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- revoke_invitation(id)
-- ---------------------------------------------------------------------------------------------
create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_registered_actor();
  inv public.invitations;
  caller_role text;
begin
  select * into inv from public.invitations i where i.id = p_invitation_id for update;
  if not found then
    raise exception using errcode = 'OD404', message = 'That invitation was not found.', detail = 'INVITATION_NOT_FOUND';
  end if;
  caller_role := private.actor_role_in_real_org(inv.organization_id, uid); -- a non-member gets the same "not found"
  if caller_role not in ('owner', 'admin') then
    raise exception using errcode = 'OD403', message = 'You do not have permission to revoke invitations.', detail = 'FORBIDDEN';
  end if;
  if inv.accepted_at is not null then
    raise exception using errcode = 'OD409', message = 'That invitation was already accepted.', detail = 'INVITATION_ACCEPTED';
  end if;
  if inv.revoked_at is null then
    update public.invitations set revoked_at = now() where id = inv.id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- redeem_invitation(token) -> { ok, organizationId, role } or { ok: false, reason }
-- ---------------------------------------------------------------------------------------------
-- The caller must be a registered user whose VERIFIED email equals the invitation's. It answers with a result object instead
-- of raising, because a raised error would roll back the recorded attempt and defeat the rate limit. Reasons: invalid (no
-- such token), revoked, used, expired, email_unverified, email_mismatch, rate_limited. Whether an email has an account is
-- never revealed: the only email information returned is about the caller's own address.
create or replace function public.redeem_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_registered_actor();
  recent integer;
  hash text;
  inv public.invitations;
  caller_email text;
  caller_verified timestamptz;
  existing text;
begin
  delete from private.invitation_redeem_attempts a where a.attempted_at < now() - interval '1 day';
  select pg_catalog.count(*) into recent from private.invitation_redeem_attempts a
   where a.user_id = uid and a.attempted_at > now() - interval '15 minutes';
  if recent >= coalesce(private.app_limit('invitation_redeem_attempts_per_15_min'), 10) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  insert into private.invitation_redeem_attempts (user_id) values (uid);

  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  hash := pg_catalog.encode(sha256(pg_catalog.convert_to(p_token, 'utf8')), 'hex');
  select * into inv from public.invitations i where i.token_hash = hash for update;
  if not found or not private.constant_time_equals(inv.token_hash, hash) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if inv.revoked_at is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;
  if inv.accepted_at is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'used');
  end if;
  if inv.expires_at <= now() then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select u.email, u.email_confirmed_at into caller_email, caller_verified from auth.users u where u.id = uid;
  if caller_verified is null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'email_unverified');
  end if;
  if pg_catalog.lower(pg_catalog.btrim(coalesce(caller_email, ''))) <> inv.email_normalized then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'email_mismatch');
  end if;
  if not exists (select 1 from public.organizations o where o.id = inv.organization_id and o.kind = 'real') then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  -- Already a member: the invitation is consumed and nothing changes (an invitation never raises or lowers an existing role).
  select m.role into existing from public.memberships m where m.organization_id = inv.organization_id and m.user_id = uid;
  if existing is null then
    insert into public.memberships (organization_id, user_id, role) values (inv.organization_id, uid, inv.role);
    existing := inv.role;
  end if;
  update public.invitations set accepted_at = now() where id = inv.id;
  return pg_catalog.jsonb_build_object('ok', true, 'organizationId', inv.organization_id, 'role', existing);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- change_membership(org_id, user_id, new_role, remove) -> { userId, role }  (role is null after a removal)
-- ---------------------------------------------------------------------------------------------
--   owner  may set any role and remove anyone, EXCEPT that the last owner can never be demoted or removed;
--   admin  may change or remove members, viewers and other admins, and set admin, member or viewer, but can never grant owner,
--          and can never change or remove an owner;
--   member and viewer may do nothing.
-- All membership changes of one workspace are serialized on its organization row, so two owners demoting each other at once
-- cannot both pass the "is there another owner?" check (the deferred last-owner constraint is the final safety net).
create or replace function public.change_membership(p_org_id uuid, p_user_id uuid, p_new_role text default null, p_remove boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := private.require_registered_actor();
  caller_role text := private.actor_role_in_real_org(p_org_id, uid);
  target_role text;
  owners integer;
begin
  if caller_role not in ('owner', 'admin') then
    raise exception using errcode = 'OD403', message = 'You do not have permission to change members.', detail = 'FORBIDDEN';
  end if;
  if not coalesce(p_remove, false) and (p_new_role is null or p_new_role not in ('owner', 'admin', 'member', 'viewer')) then
    raise exception using errcode = 'OD422', message = 'Choose Owner, Admin, Member or Viewer.', detail = 'INVALID_ROLE';
  end if;

  perform 1 from public.organizations o where o.id = p_org_id for update;

  select m.role into target_role from public.memberships m where m.organization_id = p_org_id and m.user_id = p_user_id;
  if target_role is null then
    raise exception using errcode = 'OD404', message = 'That person is not a member of this workspace.', detail = 'MEMBER_NOT_FOUND';
  end if;

  if caller_role = 'admin' then
    if target_role = 'owner' then
      raise exception using errcode = 'OD403', message = 'Only an owner can change or remove an owner.', detail = 'OWNER_PROTECTED';
    end if;
    if not coalesce(p_remove, false) and p_new_role = 'owner' then
      raise exception using errcode = 'OD403', message = 'Only an owner can make someone an owner.', detail = 'OWNER_GRANT';
    end if;
  end if;

  if coalesce(p_remove, false) then
    if target_role = 'owner' then
      select pg_catalog.count(*) into owners from public.memberships m where m.organization_id = p_org_id and m.role = 'owner';
      if owners <= 1 then
        raise exception using errcode = 'OD409', message = 'An organization must keep at least one owner.', detail = 'LAST_OWNER';
      end if;
    end if;
    delete from public.memberships m where m.organization_id = p_org_id and m.user_id = p_user_id;
    return pg_catalog.jsonb_build_object('userId', p_user_id, 'role', null);
  end if;

  if target_role = 'owner' and p_new_role <> 'owner' then
    select pg_catalog.count(*) into owners from public.memberships m where m.organization_id = p_org_id and m.role = 'owner';
    if owners <= 1 then
      raise exception using errcode = 'OD409', message = 'An organization must keep at least one owner.', detail = 'LAST_OWNER';
    end if;
  end if;
  if target_role <> p_new_role then
    update public.memberships m set role = p_new_role where m.organization_id = p_org_id and m.user_id = p_user_id;
  end if;
  return pg_catalog.jsonb_build_object('userId', p_user_id, 'role', p_new_role);
end;
$$;

revoke all on function
  public.create_invitation(uuid, text, text), public.revoke_invitation(uuid),
  public.redeem_invitation(text), public.change_membership(uuid, uuid, text, boolean)
from public, anon;
grant execute on function
  public.create_invitation(uuid, text, text), public.revoke_invitation(uuid),
  public.redeem_invitation(text), public.change_membership(uuid, uuid, text, boolean)
to authenticated;
comment on function public.create_invitation(uuid, text, text) is 'Owner/admin invites an address as admin, member or viewer; returns the plaintext token once. Real workspaces only.';
comment on function public.redeem_invitation(text) is 'A registered user with the verified matching email joins the workspace. Returns a result object so attempts are rate-limited.';
comment on function public.change_membership(uuid, uuid, text, boolean) is 'The only way roles change or members leave. Admins cannot grant or touch owners; the last owner is protected.';
