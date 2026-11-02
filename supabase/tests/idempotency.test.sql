-- pgTAP tests for the idempotency store and the version counter (SIT-183).
begin;
select plan(32);
select tests.create_fixtures();

-- ---- closed to the browser
select is((select count(*) from information_schema.role_table_grants where table_schema = 'private' and table_name = 'idempotency_keys' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0::bigint, 'no browser role has any grant on the store');
select is((select relrowsecurity from pg_class where oid = 'private.idempotency_keys'::regclass), true, 'row level security is on');
select is((select count(*) from pg_policy where polrelid = 'private.idempotency_keys'::regclass), 0::bigint, 'and no policy opens it');
select is(tests.denied_as('a_owner', 'select * from private.idempotency_keys'), true, 'a signed-in user cannot read the store directly');
select is(tests.denied_as('a_owner', 'delete from private.idempotency_keys'), true, 'or delete from it');
select is(tests.denied_as_anon('select * from private.idempotency_keys'), true, 'a signed-out caller cannot read it either');
select is((select has_function_privilege('anon', 'public.idempotency_begin(text,text,text)', 'execute')), false, 'anon cannot call begin');
select is((select has_function_privilege('authenticated', 'public.idempotency_begin(text,text,text)', 'execute')), true, 'a signed-in user (guest or member) can');

-- ---- begin / complete / replay as a_owner
select tests.act_as('a_owner');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'state'), 'new', 'first use claims the key');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'state'), 'in_progress', 'a second request while it runs is told it is in progress');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-two')->>'state'), 'mismatch', 'the same key with a different request is a mismatch');
select is(public.idempotency_complete('POST /x', 'key-aaaa-0001', 201, '{"id":"abc"}'), true, 'completing stores the result');
select is(public.idempotency_complete('POST /x', 'key-aaaa-0001', 500, '{"id":"zzz"}'), false, 'a result cannot be overwritten');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'state'), 'replay', 'a replay with the same request returns the stored result');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->'body'->>'id'), 'abc', 'the replay body is the original');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'status'), '201', 'and the original status');
select is((select public.idempotency_begin('POST /y', 'key-aaaa-0001', 'hash-one')->>'state'), 'new', 'the same token on another route is independent');

-- abandon lets the key be retried
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0002', 'hash-one')->>'state'), 'new', 'claim');
select is(public.idempotency_abandon('POST /x', 'key-aaaa-0002'), true, 'abandon releases an unfinished claim');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0002', 'hash-one')->>'state'), 'new', 'and the key can be claimed again');
select is(public.idempotency_abandon('POST /x', 'key-aaaa-0001'), false, 'a finished key cannot be abandoned');

-- validation
select throws_ok($$select public.idempotency_begin('POST /x', 'short', 'hash-one')$$, 'OD422', null, 'a short key is refused');
select throws_ok($$select public.idempotency_begin('POST /x', 'bad key with spaces!', 'hash-one')$$, 'OD422', null, 'a key with unsafe characters is refused');
select throws_ok($$select public.idempotency_begin('POST /x', repeat('a', 129), 'hash-one')$$, 'OD422', null, 'an over-long key is refused');

-- ---- another user never sees or replays a_owner's key
select tests.act_as('b_owner');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'state'), 'new', 'the same token from another user is a fresh claim, never a replay of someone else''s result');
select is(public.idempotency_complete('POST /x', 'key-aaaa-0001', 200, '{"id":"mine"}'), true, 'and completes only their own');
select tests.act_as('a_owner');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->'body'->>'id'), 'abc', 'the first user still sees their own result');

-- a signed-out caller gets nothing
select tests.act_as_anon();
select throws_ok($$select public.idempotency_begin('POST /x', 'key-aaaa-0003', 'hash-one')$$, null, null, 'a signed-out caller cannot call begin');
select tests.reset();

-- ---- expiry and crashed claims
update private.idempotency_keys set expires_at = now() - interval '1 second' where key = 'key-aaaa-0001' and user_id = tests.uid('a_owner');
insert into private.idempotency_keys (user_id, route, key, request_hash, created_at) values (tests.uid('a_owner'), 'POST /x', 'key-aaaa-0004', 'hash-one', now() - interval '3 minutes');
select tests.act_as('a_owner');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0001', 'hash-one')->>'state'), 'new', 'an expired key is claimable again');
select is((select public.idempotency_begin('POST /x', 'key-aaaa-0004', 'hash-one')->>'state'), 'new', 'a claim abandoned by a crashed request (over 2 minutes) can be retaken');
select tests.reset();

-- ---- version counter
create table public.zz_versioned (id int primary key, name text, version integer not null default 1, updated_at timestamptz not null default now());
create trigger zz_bump before update on public.zz_versioned for each row execute function private.bump_version();
insert into public.zz_versioned (id, name) values (1, 'a');
update public.zz_versioned set name = 'b' where id = 1;
select is((select version from public.zz_versioned where id = 1), 2, 'each update increments the version');
update public.zz_versioned set name = 'c', version = 99 where id = 1;
select is((select version from public.zz_versioned where id = 1), 3, 'a version supplied by the client is ignored');

select * from finish();
rollback;
