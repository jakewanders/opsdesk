-- SIT-257: the seeded stage events now read exactly like the live ones ("System moved "X" from Proposal to Negotiation",
-- with the probability as { old, new }), so the feed looks the same for seeded and real changes. Same history otherwise.
create or replace function private.seed_activity_events(org_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  o record;
  t record;
  previous_stage text;
  moved_at timestamptz;
begin
  -- Replace what the entity inserts logged just now (dated "now", a created event per row).
  -- Only the events of the records rebuilt below: another seeder's events (a later module's) are left alone.
  delete from public.activity_events e
  where e.organization_id = org_id
    and e.entity_id in (
      select x.id from public.customers x where x.organization_id = org_id
      union all select x.id from public.opportunities x where x.organization_id = org_id
      union all select x.id from public.tasks x where x.organization_id = org_id
    );
  perform pg_catalog.set_config('opsdesk.actor_mode', 'system', true);

  for c in select * from public.customers x where x.organization_id = org_id order by x.created_at, x.id loop
    perform private.log_activity(org_id, 'customer', c.id, 'created', pg_catalog.format('System created customer "%s"', c.display_name), '{}'::jsonb, c.created_at);
    if c.archived_at is not null then
      perform private.log_activity(org_id, 'customer', c.id, 'archived', pg_catalog.format('System archived customer "%s"', c.display_name), '{}'::jsonb, c.archived_at);
    end if;
  end loop;

  for o in select * from public.opportunities x where x.organization_id = org_id order by x.created_at, x.id loop
    perform private.log_activity(org_id, 'opportunity', o.id, 'created', pg_catalog.format('System created opportunity "%s"', o.title), '{}'::jsonb, o.created_at);
    if o.stage <> 'new' then
      previous_stage := case o.stage
        when 'qualified' then 'new'
        when 'proposal' then 'qualified'
        when 'negotiation' then 'proposal'
        when 'won' then 'negotiation'
        when 'lost' then 'proposal'
      end;
      moved_at := greatest(coalesce(o.closed_at, o.updated_at), o.created_at + interval '1 hour');
      perform private.log_activity(
        org_id, 'opportunity', o.id, 'stage_changed',
        pg_catalog.format('System moved "%s" from %s to %s', o.title, pg_catalog.initcap(previous_stage), pg_catalog.initcap(o.stage)),
        pg_catalog.jsonb_build_object(
          'stage', pg_catalog.jsonb_build_object('old', previous_stage, 'new', o.stage),
          'probability_percent', pg_catalog.jsonb_build_object(
            'old', case previous_stage when 'new' then 10 when 'qualified' then 25 when 'proposal' then 50 when 'negotiation' then 75 end,
            'new', o.probability_percent
          )
        ),
        moved_at
      );
    end if;
  end loop;

  for t in select * from public.tasks x where x.organization_id = org_id and x.status = 'done' and x.completed_at is not null order by x.completed_at, x.id loop
    perform private.log_activity(
      org_id, 'task', t.id, 'completed', pg_catalog.format('System completed task "%s"', pg_catalog.left(t.title, 80)),
      pg_catalog.jsonb_build_object('status', pg_catalog.jsonb_build_object('old', 'in_progress', 'new', 'done')),
      t.completed_at
    );
  end loop;
end;
$$;
revoke all on function private.seed_activity_events(uuid) from public, anon, authenticated;
-- Version 3: a reset restores the corrected history.
select private.register_demo_seeder('activity_events', 990, 'private.seed_activity_events(uuid)'::regprocedure, 3, 'private.clear_activity_events(uuid)'::regprocedure);
