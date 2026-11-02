-- SIT-196: one-time invitations (PRD 6.1, US-09). The table only STORES; the RPCs that create, redeem and revoke an invitation
-- (SIT-202) are the only writers.
--
--   * `token_hash` holds the SHA-256 of a high-entropy random token, as 64 lowercase hex characters. The plaintext token is shown
--     once to the inviter and is never stored or logged, so nothing in this table (or a backup of it) can be used to join.
--   * `role` is admin, member or viewer. An invitation can never grant owner (a CHECK, so not even the RPC can write one).
--   * `email_normalized` is lowercase and trimmed (a CHECK).
--   * `expires_at` defaults to seven days after creation and is immutable: only trusted code sets it, once, at insert.
--   * At most ONE open invitation per organization and email (a partial unique index). "Open" here means not accepted and not
--     revoked; an expired one is still open until the RPC revokes it, because an index predicate cannot read the clock.
--   * Only REAL organizations have invitations (a trigger): a demo workspace is a single guest and can never invite anyone.
--   * RLS: owners and admins of the organization may read its invitations. Nobody has insert, update or delete: the API roles
--     hold only SELECT, so every write is a trusted function.
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email_normalized text not null,
  role text not null,
  token_hash text not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint invitations_token_hash_key unique (token_hash),
  constraint invitations_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint invitations_role_values check (role in ('admin', 'member', 'viewer')),
  constraint invitations_email_normalized check (
    email_normalized = pg_catalog.lower(pg_catalog.btrim(email_normalized))
    and pg_catalog.char_length(email_normalized) between 3 and 254
    and email_normalized ~ '^[^@[:space:]]+@[^@[:space:]]+$'
  ),
  constraint invitations_expiry_after_creation check (expires_at > created_at),
  constraint invitations_one_outcome check (accepted_at is null or revoked_at is null)
);

comment on table public.invitations is
  'One-time invitations. Only a SHA-256 hash of the token is stored. Written only by the invitation RPCs (SIT-202); members and viewers cannot read it.';
comment on column public.invitations.token_hash is
  'SHA-256 of the random token, lowercase hex. Not reversible: the token itself is never stored or logged.';

create unique index invitations_one_open_per_email_idx
  on public.invitations (organization_id, email_normalized)
  where accepted_at is null and revoked_at is null;
create index invitations_org_created_idx on public.invitations (organization_id, created_at desc);

-- An invitation's identity, recipient, role, hash and expiry never change after insert; only the outcome columns
-- (`accepted_at`, `revoked_at`) are written later.
select private.protect_columns('public.invitations', 'id', 'organization_id', 'email_normalized', 'role', 'token_hash', 'invited_by', 'created_at', 'expires_at');

create or replace function private.invitation_real_org_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.organizations o where o.id = new.organization_id and o.kind = 'real') then
    raise exception using errcode = 'OD403', message = 'Invitations are only for real workspaces.', detail = 'NOT_A_REAL_ORGANIZATION';
  end if;
  return new;
end;
$$;
revoke all on function private.invitation_real_org_only() from public, anon, authenticated;
create trigger invitations_real_org_only before insert on public.invitations
  for each row execute function private.invitation_real_org_only();

alter table public.invitations enable row level security;
revoke all on table public.invitations from public, anon, authenticated;
grant select on table public.invitations to authenticated;
create policy invitations_select_admin on public.invitations
  for select to authenticated
  using (private.has_role(organization_id, array['owner', 'admin']));
