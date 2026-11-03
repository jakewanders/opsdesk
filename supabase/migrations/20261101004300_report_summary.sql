-- SIT-264: the reports page's numbers in one database function (PRD US-06, 7.4, 9.7, F13).
-- SECURITY INVOKER on purpose, like dashboard_summary: it runs with the caller's own session, so row level security decides what is
-- counted and workspace A can never count a row of workspace B. A caller who cannot see the organization gets OD404.
--
-- The range is calendar days in the ORGANIZATION's time zone, both ends included. Events are bucketed by their LOCAL calendar date
-- ((ts at time zone tz)::date), which is DST-safe: a 23- or 25-hour day is still one day. The index-friendly bounds are the instant
-- the first day starts and the instant the day after the last begins.
--   * up to 31 days: one bucket per day; longer: 7-day buckets that start on the first day of the range (the last one may be
--     shorter). Every bucket is present, zero-filled.
--   * event-based series: opportunities created (created_at), won and lost (closed_at, by stage), tasks completed (completed_at),
--     customers by source (created_at). Current-state: deals by stage. Only unarchived records count, like the dashboard.
-- Invalid ranges are OD422 (INVALID_RANGE): missing or reversed ends, or more than 366 days.
create index opportunities_org_created_idx on public.opportunities (organization_id, created_at);
create index opportunities_org_closed_idx on public.opportunities (organization_id, closed_at) where closed_at is not null;
create index tasks_org_completed_idx on public.tasks (organization_id, completed_at) where completed_at is not null;

create or replace function public.report_summary(p_org_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tz text;
  today date;
  span integer;
  step integer;
  lo timestamptz;
  hi timestamptz;
  result jsonb;
begin
  select o.timezone into tz from public.organizations o where o.id = p_org_id;
  if tz is null then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from + 1 > 366 then
    raise exception using errcode = 'OD422', message = 'Choose a range of 1 to 366 days that ends on or after its start.', detail = 'INVALID_RANGE';
  end if;
  today := (pg_catalog.now() at time zone tz)::date;
  span := p_to - p_from + 1;
  step := case when span <= 31 then 1 else 7 end;
  lo := p_from::timestamp at time zone tz;
  hi := (p_to + 1)::timestamp at time zone tz;

  with buckets as (
    select i as idx, p_from + i * step as bucket_start, least(p_from + (i + 1) * step - 1, p_to) as bucket_end
      from pg_catalog.generate_series(0, (span - 1) / step) as i
  ),
  created as (
    select ((x.created_at at time zone tz)::date - p_from) / step as idx, pg_catalog.count(*) as n
      from public.opportunities x
     where x.organization_id = p_org_id and x.archived_at is null and x.created_at >= lo and x.created_at < hi
     group by 1
  ),
  closed as (
    select ((x.closed_at at time zone tz)::date - p_from) / step as idx,
           pg_catalog.count(*) filter (where x.stage = 'won') as won,
           pg_catalog.count(*) filter (where x.stage = 'lost') as lost,
           coalesce(pg_catalog.sum(x.amount_cents) filter (where x.stage = 'won'), 0)::bigint as won_cents
      from public.opportunities x
     where x.organization_id = p_org_id and x.archived_at is null and x.closed_at >= lo and x.closed_at < hi
     group by 1
  ),
  done as (
    select ((t.completed_at at time zone tz)::date - p_from) / step as idx, pg_catalog.count(*) as n
      from public.tasks t
     where t.organization_id = p_org_id and t.archived_at is null and t.completed_at >= lo and t.completed_at < hi
     group by 1
  )
  select pg_catalog.jsonb_build_object(
    'from', p_from::text,
    'to', p_to::text,
    'days', span,
    'bucket', case when step = 1 then 'day' else 'week' end,
    'timeZone', tz,
    'today', today::text,
    'buckets', (
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'start', b.bucket_start::text,
               'end', b.bucket_end::text,
               'opportunitiesCreated', coalesce(c.n, 0),
               'opportunitiesWon', coalesce(k.won, 0),
               'opportunitiesLost', coalesce(k.lost, 0),
               'wonAmountCents', coalesce(k.won_cents, 0),
               'tasksCompleted', coalesce(d.n, 0)) order by b.idx)
        from buckets b
        left join created c on c.idx = b.idx
        left join closed k on k.idx = b.idx
        left join done d on d.idx = b.idx
    ),
    'customersBySource', (
      select pg_catalog.jsonb_object_agg(s.source, coalesce(a.n, 0))
        from (values ('referral'), ('website'), ('outbound'), ('other')) as s (source)
        left join (
          select c.source, pg_catalog.count(*) as n
            from public.customers c
           where c.organization_id = p_org_id and c.archived_at is null and c.created_at >= lo and c.created_at < hi
           group by c.source
        ) a on a.source = s.source
    ),
    'opportunitiesByStage', (
      select pg_catalog.jsonb_object_agg(s.stage, pg_catalog.jsonb_build_object('count', coalesce(a.n, 0), 'amountCents', coalesce(a.total, 0)))
        from (values ('new'), ('qualified'), ('proposal'), ('negotiation'), ('won'), ('lost')) as s (stage)
        left join (
          select x.stage, pg_catalog.count(*) as n, pg_catalog.sum(x.amount_cents)::bigint as total
            from public.opportunities x
           where x.organization_id = p_org_id and x.archived_at is null
           group by x.stage
        ) a on a.stage = s.stage
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.report_summary(uuid, date, date) from public, anon;
grant execute on function public.report_summary(uuid, date, date) to authenticated;
