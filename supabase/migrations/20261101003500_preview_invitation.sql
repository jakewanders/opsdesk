-- SIT-240: what an invitation offers, shown BEFORE the person accepts (PRD US-09): the workspace name, the role and whether
-- the signed-in account is the one invited. Same caller rules as redeem_invitation: a registered user, a rate limit shared with
-- redemption (every lookup is one attempt, recorded even when it fails), a token in its one canonical shape, and the answer
-- as an object instead of an error so the attempt row survives. It reveals nothing to someone without the token, and to a
-- holder of the token only the workspace's name, the role, the expiry and a masked form of the invited address.
create or replace function public.preview_invitation(p_token text)
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
  org_name text;
  caller_email text;
  caller_verified timestamptz;
  local_part text;
  domain_part text;
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
  select * into inv from public.invitations i where i.token_hash = hash;
  if not found or not private.constant_time_equals(inv.token_hash, hash) then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  select o.name into org_name from public.organizations o where o.id = inv.organization_id and o.kind = 'real';
  if org_name is null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  if inv.revoked_at is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'revoked', 'organizationName', org_name);
  end if;
  if inv.accepted_at is not null then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'used', 'organizationName', org_name);
  end if;
  if inv.expires_at <= now() then
    return pg_catalog.jsonb_build_object('ok', false, 'reason', 'expired', 'organizationName', org_name);
  end if;

  select u.email, u.email_confirmed_at into caller_email, caller_verified from auth.users u where u.id = uid;
  local_part := pg_catalog.split_part(inv.email_normalized, '@', 1);
  domain_part := pg_catalog.split_part(inv.email_normalized, '@', 2);
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'organizationName', org_name,
    'role', inv.role,
    'expiresAt', inv.expires_at,
    'invitedEmailHint', pg_catalog.left(local_part, 1) || '***@' || domain_part,
    'emailVerified', caller_verified is not null,
    'emailMatches', pg_catalog.lower(pg_catalog.btrim(coalesce(caller_email, ''))) = inv.email_normalized
  );
end;
$$;
revoke all on function public.preview_invitation(text) from public, anon;
grant execute on function public.preview_invitation(text) to authenticated;
