-- SIT-227: the one transactional path for every stage change (PRD US-04, 6.5, 7.4).
--
-- Why SECURITY INVOKER (the default): the RPC runs as the caller, so row level security decides what the caller can
-- see and change, exactly like a plain UPDATE. There is no privilege to escalate and nothing to re-implement: another
-- tenant's deal is invisible (404), a viewer or an expired demo fails the same `can_write` check the policies use (403).
-- The activity event is written by an AFTER trigger (SECURITY DEFINER, like every activity trigger), so the event and
-- the row change commit or roll back together.

-- ---------------------------------------------------------------------------------------------
-- Activity: a stage change is ONE `stage_changed` event, not an `updated` event plus a probability edit. The generic
-- trigger keeps title, customer, amount, close date and assignee; this trigger owns stage and probability.
-- ---------------------------------------------------------------------------------------------
select private.attach_activity_log(
  'public.opportunities', 'opportunity', 'title',
  array['title', 'customer_id', 'amount_cents', 'expected_close_date', 'assigned_to'],
  array['description', 'lost_reason'],
  'archived_at'
);

create or replace function private.log_opportunity_stage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  who text := private.activity_actor_name();
  label text := pg_catalog.format('"%s"', pg_catalog.left(new.title, 80));
  prob jsonb := pg_catalog.jsonb_build_object('old', old.probability_percent, 'new', new.probability_percent);
begin
  if new.stage is distinct from old.stage then
    perform private.log_activity(
      new.organization_id, 'opportunity', new.id, 'stage_changed',
      pg_catalog.format('%s moved %s from %s to %s', who, label, pg_catalog.initcap(old.stage), pg_catalog.initcap(new.stage)),
      pg_catalog.jsonb_build_object(
        'stage', pg_catalog.jsonb_build_object('old', old.stage, 'new', new.stage),
        'probability_percent', prob
      )
    );
  elsif new.probability_percent is distinct from old.probability_percent then
    perform private.log_activity(
      new.organization_id, 'opportunity', new.id, 'updated',
      pg_catalog.format('%s updated opportunity %s (probability_percent)', who, label),
      pg_catalog.jsonb_build_object('probability_percent', prob)
    );
  end if;
  return null;
end;
$$;
revoke all on function private.log_opportunity_stage() from public, anon, authenticated;
create trigger opportunities_stage_activity_log after update on public.opportunities
  for each row execute function private.log_opportunity_stage();

-- ---------------------------------------------------------------------------------------------
-- The RPC.
--   OD404 OPPORTUNITY_NOT_FOUND   missing or another tenant's (the same answer)
--   OD403                         the caller may not write here (viewer, expired demo)
--   OD422 INVALID_STAGE / LOST_REASON_REQUIRED / LOST_REASON_TOO_LONG
--   OD409 STALE_EDIT              the deal changed since the caller saw `p_expected_updated_at`
-- Moving to the stage the deal is already in is a no-op: the row is returned untouched and no event is written.
-- ---------------------------------------------------------------------------------------------
create or replace function public.move_opportunity_stage(
  p_id uuid,
  p_new_stage text,
  p_lost_reason text,
  p_expected_updated_at timestamptz
)
returns public.opportunities
language plpgsql
set search_path = ''
as $$
declare
  current_row public.opportunities;
  reason text := nullif(pg_catalog.btrim(coalesce(p_lost_reason, '')), '');
  result public.opportunities;
begin
  select o.* into current_row from public.opportunities o where o.id = p_id;
  if not found then
    raise exception using errcode = 'OD404', message = 'That opportunity was not found.', detail = 'OPPORTUNITY_NOT_FOUND';
  end if;
  if not private.can_write(current_row.organization_id) then
    raise exception using errcode = 'OD403', message = 'You do not have permission to change this opportunity.';
  end if;
  if p_new_stage is null or p_new_stage not in ('new', 'qualified', 'proposal', 'negotiation', 'won', 'lost') then
    raise exception using errcode = 'OD422', message = 'That is not a pipeline stage.', detail = 'INVALID_STAGE';
  end if;
  if current_row.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode = 'OD409', message = 'This record was changed by someone else since you opened it. Reload to see the latest version, then try again.', detail = 'STALE_EDIT';
  end if;
  if p_new_stage = current_row.stage then
    return current_row;
  end if;
  if p_new_stage = 'lost' then
    if reason is null then
      raise exception using errcode = 'OD422', message = 'Say why this deal was lost.', detail = 'LOST_REASON_REQUIRED';
    end if;
    if pg_catalog.char_length(reason) > 500 then
      raise exception using errcode = 'OD422', message = 'The reason can be at most 500 characters.', detail = 'LOST_REASON_TOO_LONG';
    end if;
  end if;

  -- Compare-and-set: a concurrent writer that got in after the read above makes this match nothing.
  -- The probability is reset to the new stage's default by the table's own trigger (the column is left unchanged here).
  update public.opportunities o
     set stage = p_new_stage,
         closed_at = case when p_new_stage in ('won', 'lost') then pg_catalog.now() else null end,
         lost_reason = case when p_new_stage = 'lost' then reason else null end
   where o.id = p_id and o.updated_at = p_expected_updated_at
  returning o.* into result;
  if not found then
    raise exception using errcode = 'OD409', message = 'This record was changed by someone else since you opened it. Reload to see the latest version, then try again.', detail = 'STALE_EDIT';
  end if;
  return result;
end;
$$;
revoke all on function public.move_opportunity_stage(uuid, text, text, timestamptz) from public, anon;
grant execute on function public.move_opportunity_stage(uuid, text, text, timestamptz) to authenticated;
