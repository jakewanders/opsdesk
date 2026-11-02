-- SIT-258: the demo's activity history. Until now the entity seeders' own inserts logged their events, so every event of a
-- new demo was dated "now" and nothing described a stage move or a completed task. This seeder (position 990, after the
-- entities) replaces that with a history dated from the entities themselves, so it is consistent with them:
--   customers      created at their created_at; archived at their archived_at
--   opportunities  created at their created_at; one stage_changed event for the move into the current stage, dated at
--                  closed_at for won and lost (never before the deal existed) and at updated_at for open stages
--   tasks          completed at completed_at (done tasks)
-- 18 + 3 + 10 + 8 + 5 = 44 events (tasks get completion events only) spread over about 90 days, all by the System. Everything is derived with fixed rules from
-- seeded rows ordered by created_at and id, so a reset reproduces it exactly.

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
        pg_catalog.format('System moved opportunity "%s" from %s to %s', o.title, pg_catalog.initcap(previous_stage), pg_catalog.initcap(o.stage)),
        pg_catalog.jsonb_build_object('stage', pg_catalog.jsonb_build_object('old', previous_stage, 'new', o.stage), 'probability_percent', o.probability_percent),
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
-- Version 2: a reset restores the new history.
select private.register_demo_seeder('activity_events', 990, 'private.seed_activity_events(uuid)'::regprocedure, 2, 'private.clear_activity_events(uuid)'::regprocedure);
