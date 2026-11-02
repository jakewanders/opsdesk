-- SIT-244: the dashboard's current-state numbers in one database function (PRD US-06, 7.4).
-- SECURITY INVOKER on purpose: it runs with the caller's own session, so row level security decides what is counted and
-- a member of workspace A can never count a row of workspace B. A caller who cannot see the organization (not a member,
-- or no such workspace) gets the same OD404 as everywhere else.
--
-- Rules, identical to the application's domain modules (src/lib/domain/pipeline.ts and tasks.ts; parity-tested):
--   * only unarchived records count;
--   * pipeline = amounts of the OPEN stages (new, qualified, proposal, negotiation);
--   * weighted pipeline = sum over open deals of round-half-up(amount * probability / 100), rounded PER ROW
--     ((amount * probability + 50) / 100 in integer arithmetic);
--   * "today" is the organization's local date: overdue = not done and due before today (due today is NOT overdue);
--     due in the next 7 days = not done and due from today through today + 7, both included.
-- Nothing is estimated or trended: every value is a count or a sum of stored rows.
create or replace function public.dashboard_summary(p_org_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tz text;
  today date;
  result jsonb;
begin
  select o.timezone into tz from public.organizations o where o.id = p_org_id;
  if tz is null then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  today := (pg_catalog.now() at time zone tz)::date;

  select pg_catalog.jsonb_build_object(
    'activeCustomers', (select pg_catalog.count(*) from public.customers c where c.organization_id = p_org_id and c.archived_at is null),
    'openOpportunities', (select pg_catalog.count(*) from public.opportunities x where x.organization_id = p_org_id and x.archived_at is null and x.stage in ('new', 'qualified', 'proposal', 'negotiation')),
    'pipelineCents', (select coalesce(pg_catalog.sum(x.amount_cents), 0)::bigint from public.opportunities x where x.organization_id = p_org_id and x.archived_at is null and x.stage in ('new', 'qualified', 'proposal', 'negotiation')),
    'weightedPipelineCents', (select coalesce(pg_catalog.sum((x.amount_cents * x.probability_percent + 50) / 100), 0)::bigint from public.opportunities x where x.organization_id = p_org_id and x.archived_at is null and x.stage in ('new', 'qualified', 'proposal', 'negotiation')),
    'overdueTasks', (select pg_catalog.count(*) from public.tasks t where t.organization_id = p_org_id and t.archived_at is null and t.status <> 'done' and t.due_date < today),
    'tasksDueNext7Days', (select pg_catalog.count(*) from public.tasks t where t.organization_id = p_org_id and t.archived_at is null and t.status <> 'done' and t.due_date between today and today + 7),
    'opportunitiesByStage', (
      select pg_catalog.jsonb_object_agg(s.stage, pg_catalog.jsonb_build_object('count', coalesce(a.n, 0), 'amountCents', coalesce(a.total, 0)))
        from (values ('new'), ('qualified'), ('proposal'), ('negotiation'), ('won'), ('lost')) as s (stage)
        left join (
          select x.stage, pg_catalog.count(*) as n, pg_catalog.sum(x.amount_cents)::bigint as total
            from public.opportunities x
           where x.organization_id = p_org_id and x.archived_at is null
           group by x.stage
        ) a on a.stage = s.stage
    ),
    'today', today::text,
    'timeZone', tz
  ) into result;
  return result;
end;
$$;
revoke all on function public.dashboard_summary(uuid) from public, anon;
grant execute on function public.dashboard_summary(uuid) to authenticated;
