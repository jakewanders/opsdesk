-- pgTAP tests for public.invitations (SIT-196): hashed tokens, role and email constraints, expiry, one open invitation per
-- address, real workspaces only, immutability, and RLS (admins read, nobody writes through the API roles).
begin;
select plan(41);
select tests.create_fixtures();

create function tests.hash(seed text) returns text language sql immutable as $$ select encode(sha256(convert_to(seed, 'utf8')), 'hex') $$;
grant execute on function tests.hash(text) to public;

-- ---- shape
select has_table('public', 'invitations', 'the table exists');
select is((select relrowsecurity from pg_class where oid = 'public.invitations'::regclass), true, 'row level security is on');
select is((select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = 'invitations'), 'id,organization_id,email_normalized,role,token_hash,invited_by,created_at,expires_at,accepted_at,revoked_at', 'exactly the documented columns: nothing that could hold a plaintext token');
select is((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'invitations' and grantee = 'authenticated'), 'SELECT', 'the API role holds SELECT only (no insert, update or delete)');
select is((select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'invitations' and grantee in ('anon', 'PUBLIC')), 0::bigint, 'anon holds nothing');

-- ---- inserts as the trusted role (what the RPCs will do)
select lives_ok(format($$insert into public.invitations (id, organization_id, email_normalized, role, token_hash, invited_by) values ('11000000-0000-4000-8000-000000000001', %L, 'new.person@example.com', 'member', tests.hash('t1'), %L)$$, tests.org_id('a'), tests.uid('a_owner')), 'a valid invitation inserts');
select cmp_ok((select expires_at - created_at from public.invitations where id = '11000000-0000-4000-8000-000000000001'), '=', interval '7 days', 'expires_at defaults to seven days after creation');
select is((select accepted_at is null and revoked_at is null from public.invitations where id = '11000000-0000-4000-8000-000000000001'), true, 'a new invitation is open');

-- ---- constraints
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'o@example.com', 'owner', tests.hash('t2'))$$, tests.org_id('a')), '23514', null, 'an owner invitation is rejected by constraint');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'o@example.com', 'superuser', tests.hash('t3'))$$, tests.org_id('a')), '23514', null, 'an unknown role is rejected');
select lives_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'admin.person@example.com', 'admin', tests.hash('t4')), (%L, 'viewer.person@example.com', 'viewer', tests.hash('t5'))$$, tests.org_id('a'), tests.org_id('a')), 'admin and viewer invitations are fine');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'Mixed.Case@Example.com', 'member', tests.hash('t6'))$$, tests.org_id('a')), '23514', null, 'an email that is not lowercase is rejected');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, ' padded@example.com ', 'member', tests.hash('t7'))$$, tests.org_id('a')), '23514', null, 'an email with surrounding spaces is rejected');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'no-at-sign', 'member', tests.hash('t8'))$$, tests.org_id('a')), '23514', null, 'a value that is not an address is rejected');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'a@b.example', 'member', 'the-plaintext-token-itself')$$, tests.org_id('a')), '23514', null, 'a token_hash that is not 64 hex characters (a plaintext token) is rejected');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'b@b.example', 'member', upper(tests.hash('t9')))$$, tests.org_id('a')), '23514', null, 'an upper-case hash is rejected (one canonical form)');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'c@b.example', 'member', tests.hash('t1'))$$, tests.org_id('a')), '23505', null, 'the same token hash cannot be stored twice');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash, created_at, expires_at) values (%L, 'd@b.example', 'member', tests.hash('t10'), now(), now() - interval '1 day')$$, tests.org_id('a')), '23514', null, 'an invitation cannot expire before it was created');
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash, accepted_at, revoked_at) values (%L, 'e@b.example', 'member', tests.hash('t11'), now(), now())$$, tests.org_id('a')), '23514', null, 'an invitation cannot be both accepted and revoked');

-- ---- one open invitation per organization and address
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'new.person@example.com', 'viewer', tests.hash('t12'))$$, tests.org_id('a')), '23505', null, 'a second OPEN invitation for the same address in the same workspace is refused');
select lives_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'new.person@example.com', 'viewer', tests.hash('t13'))$$, tests.org_id('b')), 'the same address can be invited to a different workspace');
update public.invitations set revoked_at = now() where id = '11000000-0000-4000-8000-000000000001';
select lives_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'new.person@example.com', 'viewer', tests.hash('t14'))$$, tests.org_id('a')), 'after a revocation the address can be invited again');

-- ---- real workspaces only
select throws_ok(format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'guest.invite@example.com', 'member', tests.hash('t15'))$$, tests.org_id('g1')), 'OD403', 'Invitations are only for real workspaces.', 'a demo workspace can never have an invitation');

-- ---- immutability: only the outcome columns change after insert
select throws_ok($$update public.invitations set role = 'viewer' where id = '11000000-0000-4000-8000-000000000001'$$, 'OD403', 'This field cannot be changed.', 'the role is fixed at creation');
select throws_ok($$update public.invitations set email_normalized = 'other@example.com' where id = '11000000-0000-4000-8000-000000000001'$$, 'OD403', 'This field cannot be changed.', 'the address is fixed at creation');
select throws_ok(format($$update public.invitations set token_hash = %L where id = '11000000-0000-4000-8000-000000000001'$$, tests.hash('swap')), 'OD403', 'This field cannot be changed.', 'the hash is fixed at creation');
select throws_ok($$update public.invitations set expires_at = now() + interval '365 days' where id = '11000000-0000-4000-8000-000000000001'$$, 'OD403', 'This field cannot be changed.', 'the expiry cannot be extended after creation');
select throws_ok(format($$update public.invitations set organization_id = %L where id = '11000000-0000-4000-8000-000000000001'$$, tests.org_id('b')), 'OD403', 'This field cannot be changed.', 'an invitation cannot move to another workspace');
select lives_ok($$update public.invitations set accepted_at = null where id = '11000000-0000-4000-8000-000000000001'$$, 'the outcome columns can still be written by trusted code');

-- ---- row level security: reads
insert into public.invitations (id, organization_id, email_normalized, role, token_hash) values
  ('11000000-0000-4000-8000-0000000000b1', tests.org_id('b'), 'b.only@example.com', 'member', tests.hash('b-only'));
select is(tests.visible_count_as('a_owner', 'public.invitations'), 4::bigint, 'an owner reads their workspace''s 4 invitations (not the other workspace''s)');
select is(tests.visible_count_as('a_admin', 'public.invitations'), 4::bigint, 'an admin reads them too');
select is(tests.visible_count_as('a_member', 'public.invitations'), 0::bigint, 'a member reads none');
select is(tests.visible_count_as('a_viewer', 'public.invitations'), 0::bigint, 'a viewer reads none');
select is(tests.visible_count_as('outsider', 'public.invitations'), 0::bigint, 'a non-member reads none');
select is(tests.visible_count_as('b_owner', 'public.invitations', format('organization_id = %L', tests.org_id('a'))), 0::bigint, 'another workspace''s owner cannot read this workspace''s invitations');
select is(tests.visible_count_as('g1', 'public.invitations'), 0::bigint, 'a demo guest reads none');
select tests.act_as_anon();
select is(tests.sqlstate_of('select count(*) from public.invitations'), '42501', 'anon cannot read the table');
select tests.reset();

-- ---- no client writes, whatever the role
select is(tests.denied_as('a_owner', format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'x@example.com', 'member', tests.hash('c1'))$$, tests.org_id('a'))), true, 'an owner cannot insert directly');
select is(tests.denied_as('a_admin', $$update public.invitations set revoked_at = now()$$), true, 'an admin cannot update directly');
select is(tests.denied_as('a_owner', $$delete from public.invitations$$), true, 'an owner cannot delete directly');
select is(tests.denied_as('g1', format($$insert into public.invitations (organization_id, email_normalized, role, token_hash) values (%L, 'x@example.com', 'member', tests.hash('c2'))$$, tests.org_id('g1'))), true, 'a guest cannot insert');

select * from finish();
rollback;
