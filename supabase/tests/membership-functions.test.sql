-- pgTAP tests for create_invitation, revoke_invitation, redeem_invitation and change_membership (SIT-202): who may call them,
-- every reject case, the last-owner guard, no privilege escalation, hashed tokens, and the redemption rate limit.
begin;
select plan(104);
select tests.create_fixtures();
-- verified addresses for everyone except a_viewer
update auth.users set email_confirmed_at = now() where email like '%@example.test' and email <> 'a_viewer@example.test';

create function tests.sha(t text) returns text language sql immutable as $$ select encode(sha256(convert_to(t, 'utf8')), 'hex') $$;
grant execute on function tests.sha(text) to public;
create temp table made (label text primary key, id uuid, token text);
grant all on made to public;

-- ---- shape and privileges
select is((select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('create_invitation', 'revoke_invitation', 'redeem_invitation', 'change_membership')), 4::bigint, 'the four functions exist');
select is((select count(*) from pg_proc p where pronamespace = 'public'::regnamespace and proname in ('create_invitation', 'revoke_invitation', 'redeem_invitation', 'change_membership') and prosecdef and 'search_path=""' = any (coalesce(proconfig, '{}'))), 4::bigint, 'all four are SECURITY DEFINER with a pinned empty search_path');
select is((select count(*) from pg_proc p where pronamespace = 'public'::regnamespace and proname in ('create_invitation', 'revoke_invitation', 'redeem_invitation', 'change_membership') and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('public', p.oid, 'execute')), 4::bigint, 'EXECUTE for authenticated only (not anon, not PUBLIC)');
select is((select count(*) from pg_proc p, unnest(p.proargnames) a where pronamespace = 'public'::regnamespace and proname in ('create_invitation', 'revoke_invitation', 'redeem_invitation', 'change_membership') and a ~ 'actor|caller|inviter|invited_by'), 0::bigint, 'no function takes an actor: the caller is always auth.uid()');
select ok(not has_function_privilege('authenticated', 'private.require_registered_actor()', 'execute') and not has_function_privilege('authenticated', 'private.actor_role_in_real_org(uuid, uuid)', 'execute'), 'the internal helpers are not callable by clients');
select is(private.constant_time_equals('abc', 'abc'), true, 'constant_time_equals: equal strings');
select is(private.constant_time_equals('abc', 'abd') or private.constant_time_equals('abc', 'ab') or private.constant_time_equals('', 'a'), false, 'constant_time_equals: different strings, different lengths');

-- ---- who may call at all
select tests.act_as_anon();
select is(tests.sqlstate_of(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), '42501', 'anon cannot call create_invitation');
select is(tests.sqlstate_of($$select public.redeem_invitation('00')$$), '42501', 'anon cannot call redeem_invitation');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('a_member'))), '42501', 'anon cannot call change_membership');
select tests.reset();
select tests.act_as('g1');
select is(tests.sqlstate_of(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('g1'))), 'OD403', 'a demo guest cannot invite (even into their own demo)');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('g1'), tests.uid('g1'))), 'OD403', 'a demo guest cannot change membership');
select is(tests.sqlstate_of($$select public.redeem_invitation(repeat('a', 64))$$), 'OD403', 'a demo guest cannot redeem');
select is(tests.sqlstate_of($$select public.revoke_invitation(gen_random_uuid())$$), 'OD403', 'a demo guest cannot revoke');
select tests.reset();
select tests.act_as_role('authenticated', tests.uid('g1'), false);
select is(tests.sqlstate_of(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('g1'))), 'OD403', 'a guest whose JWT claims is_anonymous = false is still refused (the stored user must be registered)');
select tests.reset();
select tests.act_as_role('authenticated', tests.uid('a_owner'), true);
select is(tests.sqlstate_of(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), 'OD403', 'a registered owner with a forged anonymous claim is refused');
select tests.reset();
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select is(tests.sqlstate_of(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), 'OD403', 'a call with no identity is refused');
select throws_ok(format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a')), 'OD403', 'Sign in to continue.', 'and it is told to sign in (not that it is a guest)');
select tests.reset();

-- ---- create_invitation
select is(tests.sqlstate_of_as('outsider', format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), 'OD404', 'a non-member gets "not found" (the workspace''s existence is not revealed)');
select is(tests.sqlstate_of_as('b_owner', format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), 'OD404', 'another workspace''s owner gets the same answer');
select is(tests.sqlstate_of_as('a_owner', $$select public.create_invitation('00000000-0000-4000-8000-000000000000', 'x@example.com', 'member')$$), 'OD404', 'an unknown workspace id is the same answer');
select is(tests.sqlstate_of_as('a_member', format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('a'))), 'OD403', 'a member cannot invite');
select is(tests.sqlstate_of_as('a_viewer', format($$select public.create_invitation(%L, 'x@example.com', 'viewer')$$, tests.org_id('a'))), 'OD403', 'a viewer cannot invite');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'x@example.com', 'owner')$$, tests.org_id('a'))), 'OD422', 'an owner invitation is refused, even for an owner');
select is(tests.sqlstate_of_as('a_admin', format($$select public.create_invitation(%L, 'x@example.com', 'owner')$$, tests.org_id('a'))), 'OD422', 'an admin cannot invite an owner');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'x@example.com', 'root')$$, tests.org_id('a'))), 'OD422', 'an unknown role is refused');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'not-an-address', 'member')$$, tests.org_id('a'))), 'OD422', 'a bad address is refused');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'a@b.example', null)$$, tests.org_id('a'))), 'OD422', 'a missing role is refused');
-- as a registered owner of a DEMO workspace (membership inserted directly): still refused, a demo is not a real workspace
insert into public.memberships (organization_id, user_id, role) values (tests.org_id('g1'), tests.uid('a_owner'), 'owner');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'x@example.com', 'member')$$, tests.org_id('g1'))), 'OD404', 'a demo workspace cannot take invitations');
delete from public.memberships where organization_id = tests.org_id('g1') and user_id = tests.uid('a_owner');

select tests.act_as('a_owner');
insert into made select 'owner_invite', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('a'), '  Invitee.One@Example.COM ', 'member') r) s;
select tests.reset();
select ok((select token ~ '^[0-9a-f]{64}$' from made where label = 'owner_invite'), 'the token is 64 hex characters (256 bits)');
select is((select email_normalized from public.invitations where id = (select id from made where label = 'owner_invite')), 'invitee.one@example.com', 'the address is normalized (trimmed, lower case)');
select is((select token_hash from public.invitations where id = (select id from made where label = 'owner_invite')), tests.sha((select token from made where label = 'owner_invite')), 'only the SHA-256 of the token is stored');
select is((select count(*) from public.invitations i where i::text like '%' || (select token from made where label = 'owner_invite') || '%'), 0::bigint, 'the plaintext token appears nowhere in the stored row');
select is((select invited_by from public.invitations where id = (select id from made where label = 'owner_invite')), tests.uid('a_owner'), 'the inviter is the caller');
select cmp_ok((select expires_at - created_at from public.invitations where id = (select id from made where label = 'owner_invite')), '=', interval '7 days', 'it expires in seven days');
select tests.act_as('a_admin');
select lives_ok(format($$select public.create_invitation(%L, 'admin.made@example.com', 'admin')$$, tests.org_id('a')), 'an admin can invite an admin');
select lives_ok(format($$select public.create_invitation(%L, 'viewer.made@example.com', 'viewer')$$, tests.org_id('a')), 'and a viewer');
select tests.reset();
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'invitee.one@example.com', 'viewer')$$, tests.org_id('a'))), 'OD409', 'a second OPEN invitation for the same address is refused');
select is(tests.sqlstate_of_as('a_owner', format($$select public.create_invitation(%L, 'A_MEMBER@example.test', 'viewer')$$, tests.org_id('a'))), 'OD409', 'inviting someone who is already a member is refused');
-- expiry: the stale open invitation is closed and the address can be invited again
alter table public.invitations disable trigger invitations_protect_columns;
update public.invitations set expires_at = now() - interval '1 hour', created_at = now() - interval '8 days' where email_normalized = 'viewer.made@example.com';
alter table public.invitations enable trigger invitations_protect_columns;
select tests.act_as('a_owner');
select lives_ok(format($$select public.create_invitation(%L, 'viewer.made@example.com', 'member')$$, tests.org_id('a')), 'an expired, unanswered invitation does not block inviting the address again');
select tests.reset();
select is((select count(*) from public.invitations where email_normalized = 'viewer.made@example.com' and revoked_at is not null), 1::bigint, 'and the stale one was closed');
-- the open-invitation limit
update private.app_limits set value = 3 where key = 'max_open_invitations_per_org';
select tests.act_as('a_owner');
select throws_ok(format($$select public.create_invitation(%L, 'one.too.many@example.com', 'member')$$, tests.org_id('a')), 'OD429', null, 'a workspace cannot hold more open invitations than the limit');
select tests.reset();
update private.app_limits set value = 100 where key = 'max_open_invitations_per_org';

-- ---- redeem_invitation
select tests.act_as('b_owner');
insert into made select 'for_outsider', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('b'), 'outsider@example.test', 'viewer') r) s;
insert into made select 'for_unverified', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('b'), 'a_viewer@example.test', 'member') r) s;
insert into made select 'for_someone_else', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('b'), 'someone.else@example.com', 'member') r) s;
insert into made select 'for_member', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('b'), 'a_member@example.test', 'admin') r) s;
insert into made select 'to_revoke', (r ->> 'id')::uuid, r ->> 'token' from (select public.create_invitation(tests.org_id('b'), 'revoked.one@example.com', 'member') r) s;
select tests.reset();
select tests.act_as('outsider');
select is((select public.redeem_invitation((select token from made where label = 'for_someone_else'))), '{"ok": false, "reason": "email_mismatch"}'::jsonb, 'a token for another address is refused (email_mismatch)');
select is((select public.redeem_invitation('nope')), '{"ok": false, "reason": "invalid"}'::jsonb, 'a malformed token is invalid');
select is((select public.redeem_invitation(upper((select token from made where label = 'for_outsider')))), '{"ok": false, "reason": "invalid"}'::jsonb, 'an upper-cased token is invalid (one canonical form)');
select is((select public.redeem_invitation(repeat('0', 64))), '{"ok": false, "reason": "invalid"}'::jsonb, 'a well-formed unknown token is invalid');
select tests.reset();
select tests.act_as('a_viewer');
select is((select public.redeem_invitation((select token from made where label = 'for_unverified'))), '{"ok": false, "reason": "email_unverified"}'::jsonb, 'an unverified email cannot redeem even its own invitation');
select tests.reset();
-- revoked and expired
select tests.act_as('b_admin');
select lives_ok(format($$select public.revoke_invitation(%L)$$, (select id from made where label = 'to_revoke')), 'an admin can revoke');
select lives_ok(format($$select public.revoke_invitation(%L)$$, (select id from made where label = 'to_revoke')), 'revoking twice is fine');
select tests.reset();
select tests.act_as('outsider');
select is((select public.redeem_invitation((select token from made where label = 'to_revoke'))), '{"ok": false, "reason": "revoked"}'::jsonb, 'a revoked token is refused');
select tests.reset();
alter table public.invitations disable trigger invitations_protect_columns;
update public.invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = (select id from made where label = 'for_outsider');
alter table public.invitations enable trigger invitations_protect_columns;
select tests.act_as('outsider');
select is((select public.redeem_invitation((select token from made where label = 'for_outsider'))), '{"ok": false, "reason": "expired"}'::jsonb, 'an expired token is refused');
select tests.reset();
alter table public.invitations disable trigger invitations_protect_columns;
update public.invitations set expires_at = now() + interval '7 days', created_at = now() where id = (select id from made where label = 'for_outsider');
alter table public.invitations enable trigger invitations_protect_columns;
-- success
select tests.act_as('outsider');
select is((select public.redeem_invitation((select token from made where label = 'for_outsider'))), jsonb_build_object('ok', true, 'organizationId', tests.org_id('b'), 'role', 'viewer'), 'the matching verified user joins with the invited role');
select tests.reset();
select is((select role from public.memberships where organization_id = tests.org_id('b') and user_id = tests.uid('outsider')), 'viewer', 'the membership exists');
select isnt((select accepted_at from public.invitations where id = (select id from made where label = 'for_outsider')), null, 'and the invitation is marked accepted (one transaction)');
select tests.act_as('outsider');
select is((select public.redeem_invitation((select token from made where label = 'for_outsider'))), '{"ok": false, "reason": "used"}'::jsonb, 'a second use is refused (used)');
select tests.reset();
-- ---- preview_invitation: what the link offers, before accepting
select tests.act_as_anon();
select is(tests.sqlstate_of($$select public.preview_invitation(repeat('a', 64))$$), '42501', 'anon cannot preview');
select tests.reset();
select tests.act_as('g1');
select is(tests.sqlstate_of($$select public.preview_invitation(repeat('a', 64))$$), 'OD403', 'a demo guest cannot preview');
select tests.reset();
select tests.act_as('a_member');
select is((select (r ->> 'organizationName') || '/' || (r ->> 'role') || '/' || (r ->> 'invitedEmailHint') from (select public.preview_invitation((select token from made where label = 'for_member')) r) s), 'Org B/admin/a***@example.test', 'the matching person sees the workspace name, the role and a masked address');
select is((select r -> 'emailMatches' from (select public.preview_invitation((select token from made where label = 'for_member')) r) s), 'true'::jsonb, 'and that their account is the one invited');
select is((select r::text like '%a_member@example.test%' or r::text like '%' || (select token from made where label = 'for_member') || '%' from (select public.preview_invitation((select token from made where label = 'for_member')) r) s), false, 'neither the full address nor the token is echoed');
select tests.reset();
select tests.act_as('b_admin');
select is((select r -> 'emailMatches' from (select public.preview_invitation((select token from made where label = 'for_member')) r) s), 'false'::jsonb, 'someone else holding the link is told it is not their account');
select tests.reset();
select tests.act_as('a_viewer');
select is((select r -> 'emailVerified' from (select public.preview_invitation((select token from made where label = 'for_unverified')) r) s), 'false'::jsonb, 'an unverified address is flagged before accepting');
select is((select public.preview_invitation('nope')), '{"ok": false, "reason": "invalid"}'::jsonb, 'a malformed token is invalid');
select is((select public.preview_invitation(repeat('0', 64))), '{"ok": false, "reason": "invalid"}'::jsonb, 'an unknown token is invalid');
select is((select public.preview_invitation((select token from made where label = 'to_revoke'))), '{"ok": false, "reason": "revoked", "organizationName": "Org B"}'::jsonb, 'a revoked invitation says so, naming the workspace');
select is((select public.preview_invitation((select token from made where label = 'for_outsider'))), '{"ok": false, "reason": "used", "organizationName": "Org B"}'::jsonb, 'a used invitation says so');
select tests.reset();
alter table public.invitations disable trigger invitations_protect_columns;
update public.invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = (select id from made where label = 'for_someone_else');
alter table public.invitations enable trigger invitations_protect_columns;
select tests.act_as('a_viewer');
select is((select public.preview_invitation((select token from made where label = 'for_someone_else'))), '{"ok": false, "reason": "expired", "organizationName": "Org B"}'::jsonb, 'an expired invitation says so');
select tests.reset();
delete from private.invitation_redeem_attempts;
update private.app_limits set value = 2 where key = 'invitation_redeem_attempts_per_15_min';
select tests.act_as('b_member');
select public.preview_invitation(repeat('1', 64)); select public.preview_invitation(repeat('2', 64));
select is((select public.preview_invitation(repeat('3', 64))), '{"ok": false, "reason": "rate_limited"}'::jsonb, 'previews share the redemption rate limit');
select tests.reset();
update private.app_limits set value = 10 where key = 'invitation_redeem_attempts_per_15_min';
delete from private.invitation_redeem_attempts;
select ok(not has_function_privilege('anon', 'public.preview_invitation(text)', 'execute') and has_function_privilege('authenticated', 'public.preview_invitation(text)', 'execute'), 'preview_invitation: EXECUTE for authenticated only');

-- a second workspace's invitation for an existing member of another workspace works independently
select tests.act_as('a_member');
select is((select public.redeem_invitation((select token from made where label = 'for_member'))), jsonb_build_object('ok', true, 'organizationId', tests.org_id('b'), 'role', 'admin'), 'a member of one workspace can join another by invitation (case-insensitive address match)');
select tests.reset();
select is((select role from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_member')), 'member', 'and their role in the first workspace is untouched');
-- rate limit
update private.app_limits set value = 3 where key = 'invitation_redeem_attempts_per_15_min';
select tests.act_as('b_member');
select public.redeem_invitation(repeat('1', 64)); select public.redeem_invitation(repeat('2', 64)); select public.redeem_invitation(repeat('3', 64));
select is((select public.redeem_invitation(repeat('4', 64))), '{"ok": false, "reason": "rate_limited"}'::jsonb, 'after the limit, further attempts are refused (rate_limited)');
select tests.reset();
select is((select count(*) from private.invitation_redeem_attempts where user_id = tests.uid('b_member')), 3::bigint, 'failed attempts were recorded and survived (the function answers instead of raising)');
update private.app_limits set value = 10 where key = 'invitation_redeem_attempts_per_15_min';

-- ---- revoke_invitation rules
select is(tests.sqlstate_of_as('a_owner', format($$select public.revoke_invitation(%L)$$, (select id from made where label = 'for_someone_else'))), 'OD404', 'an owner of another workspace gets "not found" for an invitation elsewhere');
select is(tests.sqlstate_of_as('b_member', format($$select public.revoke_invitation(%L)$$, (select id from made where label = 'for_someone_else'))), 'OD403', 'a member of the same workspace cannot revoke');
select is(tests.sqlstate_of_as('b_owner', format($$select public.revoke_invitation(%L)$$, (select id from made where label = 'for_outsider'))), 'OD409', 'an accepted invitation cannot be revoked');
select is(tests.sqlstate_of_as('b_owner', $$select public.revoke_invitation(gen_random_uuid())$$), 'OD404', 'an unknown invitation is not found');
select tests.act_as('b_owner');
select throws_ok($$select public.revoke_invitation(gen_random_uuid())$$, 'OD404', 'That invitation was not found.', 'and it says the invitation, not the workspace, was not found');
select tests.reset();

-- ---- change_membership: owners
select tests.act_as('a_owner');
select is((select public.change_membership(tests.org_id('a'), tests.uid('a_member'), 'admin')), jsonb_build_object('userId', tests.uid('a_member'), 'role', 'admin'), 'an owner promotes a member to admin');
select is((select role from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_member')), 'admin', 'and it is stored');
select lives_ok(format($$select public.change_membership(%L, %L, 'member')$$, tests.org_id('a'), tests.uid('a_member')), 'and back');
select lives_ok(format($$select public.change_membership(%L, %L, 'member')$$, tests.org_id('a'), tests.uid('a_member')), 'a change to the same role is a no-op');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'superuser')$$, tests.org_id('a'), tests.uid('a_member'))), 'OD422', 'an unknown role is refused');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, null)$$, tests.org_id('a'), tests.uid('a_member'))), 'OD422', 'no role and no removal is refused');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('outsider'))), 'OD404', 'changing someone who is not a member is "not found"');
-- the last owner
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'admin')$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD409', 'the only owner cannot demote themselves');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, null, true)$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD409', 'the only owner cannot remove themselves');
select is((select role from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_owner')), 'owner', 'and they are still the owner');
select lives_ok(format($$select public.change_membership(%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('a_admin')), 'an owner can make another owner');
select lives_ok(format($$select public.change_membership(%L, %L, 'admin')$$, tests.org_id('a'), tests.uid('a_owner')), 'with two owners one can step down');
select tests.reset();
select tests.act_as('a_admin'); -- now the only owner
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, null, true)$$, tests.org_id('a'), tests.uid('a_admin'))), 'OD409', 'the remaining owner cannot be removed');
select lives_ok(format($$select public.change_membership(%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('a_owner')), 'ownership can be handed back');
select tests.reset();

-- ---- change_membership: admins cannot escalate
select tests.act_as('a_owner');
select public.change_membership(tests.org_id('a'), tests.uid('a_admin'), 'admin');
select public.change_membership(tests.org_id('a'), tests.uid('a_admin'), 'admin');
select tests.reset();
select tests.act_as('a_admin');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('a_admin'))), 'OD403', 'an admin cannot promote themselves to owner');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('a_member'))), 'OD403', 'an admin cannot promote anyone to owner');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, 'member')$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD403', 'an admin cannot demote an owner');
select is(tests.sqlstate_of(format($$select public.change_membership(%L, %L, null, true)$$, tests.org_id('a'), tests.uid('a_owner'))), 'OD403', 'an admin cannot remove an owner');
select lives_ok(format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('a_member')), 'an admin can change a member''s role');
select lives_ok(format($$select public.change_membership(%L, %L, null, true)$$, tests.org_id('a'), tests.uid('a_viewer')), 'an admin can remove a viewer');
select tests.reset();
select is((select count(*) from public.memberships where organization_id = tests.org_id('a') and user_id = tests.uid('a_viewer')), 0::bigint, 'the removed member is gone');
select is(tests.sqlstate_of_as('a_member', format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('a_admin'))), 'OD403', 'a member cannot change anyone (their own role was lowered above, so this is still a refusal)');
select is(tests.sqlstate_of_as('outsider', format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('a_admin'))), 'OD404', 'a non-member gets "not found"');
select is(tests.sqlstate_of_as('b_owner', format($$select public.change_membership(%L, %L, 'viewer')$$, tests.org_id('a'), tests.uid('a_admin'))), 'OD404', 'another workspace''s owner gets "not found"');

-- ---- the API roles still have no direct write to memberships
select is(tests.denied_as('a_owner', format($$update public.memberships set role = 'owner' where organization_id = %L$$, tests.org_id('a'))), true, 'no direct role update on memberships, even for an owner');
select is(tests.denied_as('a_admin', format($$insert into public.memberships (organization_id, user_id, role) values (%L, %L, 'owner')$$, tests.org_id('a'), tests.uid('outsider'))), true, 'no direct membership insert, even for an admin');

select * from finish();
rollback;
