-- pgTAP tests for the quote history (SIT-267, PRD 6.4, 11.2): every status change, every creation and every revision leaves exactly one
-- activity event written by the database with the actor and the old and new status; a refused change leaves none; clients cannot write
-- the history; the numbering sequence and the lines are not touched by a refused change.
begin;
select plan(27);
select tests.create_fixtures();
insert into public.customers (id, organization_id, display_name) values
  ('c1000000-0000-4000-8000-0000000000a1', tests.org_id('a'), 'Acme Customer');
update public.profiles set display_name = 'Mia Member' where id = tests.uid('a_member');

create function pg_temp.mk(title text) returns uuid language plpgsql as $$
declare r public.quotes;
begin
  perform tests.act_as('a_member');
  select * into r from public.create_quote_with_items(tests.org_id('a'), 'c1000000-0000-4000-8000-0000000000a1', null, title, null, null, 0, 0, null,
    '[{"description":"Line","quantity":1,"unitPriceCents":1000}]'::jsonb);
  perform tests.reset();
  return r.id;
end $$;
create function pg_temp.move(qid uuid, v integer, target text) returns void language plpgsql as $$
begin
  perform tests.act_as('a_member');
  perform public.transition_quote(qid, v, target);
  perform tests.reset();
end $$;
create function pg_temp.revise(qid uuid) returns uuid language plpgsql as $$
declare r public.quotes;
begin
  perform tests.act_as('a_member');
  select * into r from public.revise_quote(qid);
  perform tests.reset();
  return r.id;
end $$;
create function pg_temp.events(qid uuid) returns bigint language sql as $$
  select count(*) from public.activity_events where entity_type = 'quote' and entity_id = qid
$$;
create function pg_temp.status_events(qid uuid) returns text language sql as $$
  select coalesce(string_agg((changes -> 'status' ->> 'old') || '>' || (changes -> 'status' ->> 'new'), ',' order by created_at, id), '')
  from public.activity_events where entity_type = 'quote' and entity_id = qid and changes ? 'status'
$$;

create temp table q (k text primary key, id uuid);
insert into q values ('a', pg_temp.mk('Path A')), ('b', pg_temp.mk('Path B')), ('c', pg_temp.mk('Path C'));

-- ---- creation
select is(pg_temp.events((select id from q where k = 'a')), 1::bigint, 'creating a quote leaves exactly one event');
select is((select action from public.activity_events where entity_id = (select id from q where k = 'a')), 'created', 'a created event');
select is((select actor_user_id from public.activity_events where entity_id = (select id from q where k = 'a')), tests.uid('a_member'), 'by the person who created it');
select is((select summary from public.activity_events where entity_id = (select id from q where k = 'a')), 'Mia Member created quote "Q-000001"', 'whose summary names who and which quote, with the number');

-- ---- every allowed transition, one event each
select pg_temp.move((select id from q where k = 'a'), 1, 'sent');
select is(pg_temp.events((select id from q where k = 'a')), 2::bigint, 'draft -> sent adds one event');
select is(pg_temp.status_events((select id from q where k = 'a')), 'draft>sent', 'with the old and new status');
select pg_temp.move((select id from q where k = 'a'), 2, 'approved');
select is(pg_temp.status_events((select id from q where k = 'a')), 'draft>sent,sent>approved', 'sent -> approved is the next event');
select is(pg_temp.events((select id from q where k = 'a')), 3::bigint, 'and only one');

select pg_temp.move((select id from q where k = 'b'), 1, 'sent');
select pg_temp.move((select id from q where k = 'b'), 2, 'rejected');
select is(pg_temp.status_events((select id from q where k = 'b')), 'draft>sent,sent>rejected', 'sent -> rejected is logged');
select pg_temp.move((select id from q where k = 'c'), 1, 'sent');
select pg_temp.move((select id from q where k = 'c'), 2, 'expired');
select is(pg_temp.status_events((select id from q where k = 'c')), 'draft>sent,sent>expired', 'sent -> expired is logged');
select is((select count(*) from public.activity_events where entity_type = 'quote' and changes ? 'status' and actor_user_id = tests.uid('a_member')), 6::bigint, 'six status events in all, each by the caller');
select is((select count(*) from public.activity_events where entity_type = 'quote' and action = 'updated' and summary like 'Mia Member updated quote%'), 6::bigint, 'each summary names the actor');

-- ---- a refused change leaves nothing behind
select is(tests.sqlstate_of($$select pg_temp.move((select id from q where k = 'b'), 3, 'approved')$$), 'OD409', 'rejected -> approved is refused');
select is(pg_temp.events((select id from q where k = 'b')), 3::bigint, 'and adds no event');
select is(tests.sqlstate_of($$select pg_temp.move((select id from q where k = 'a'), 1, 'expired')$$), 'OD409', 'a stale version is refused');
select is(pg_temp.events((select id from q where k = 'a')), 3::bigint, 'and adds no event');
select is((select version from public.quotes where id = (select id from q where k = 'a')), 3, 'the version did not move');

-- ---- revisions: the new draft is created; the original gets nothing
select is((select count(*) from public.activity_events where entity_type = 'quote' and action = 'created'), 3::bigint, 'three created events so far');
insert into q values ('rev', pg_temp.revise((select id from q where k = 'a')));
select is(pg_temp.events((select id from q where k = 'rev')), 1::bigint, 'revising creates one event for the new draft');
select is((select action from public.activity_events where entity_id = (select id from q where k = 'rev')), 'created', 'a created event');
select is(pg_temp.events((select id from q where k = 'a')), 3::bigint, 'and the original gains nothing');
select is((select quote_number from public.quotes where id = (select id from q where k = 'rev')), 'Q-000004', 'the revision took the next number');
select is((select next_number from public.quote_sequences where organization_id = tests.org_id('a')), 5::bigint, 'the sequence moved once for it, and not for the refused changes');

-- ---- nobody but the database writes the history
select tests.act_as('a_owner');
select is(tests.denied($$insert into public.activity_events (organization_id, entity_type, entity_id, action, summary) values (tests.org_id('a'), 'quote', gen_random_uuid(), 'created', 'forged')$$), true, 'an owner cannot insert an event');
select is(tests.denied($$update public.activity_events set summary = 'edited' where entity_type = 'quote'$$), true, 'cannot edit one');
select is(tests.denied($$delete from public.activity_events where entity_type = 'quote'$$), true, 'cannot delete one');
select tests.reset();
select tests.act_as('b_owner');
select is((select count(*) from public.activity_events where entity_type = 'quote'), 0::bigint, 'another workspace sees none of this history');
select tests.reset();

select * from finish();
rollback;
