-- SIT-217 finding: private.prepare_opportunity() runs as the CALLING role (a trigger function is SECURITY INVOKER here),
-- and it called private.stage_default_probability(), which no API role may execute. It passed in tests that had already
-- run an insert as the server role (the plan was cached), but the first insert by a member in a fresh session failed
-- with "permission denied for function stage_default_probability". The default is now inline, so the trigger needs no
-- privilege beyond the table's own; the helper is dropped.
create or replace function private.prepare_opportunity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  stage_default smallint;
begin
  new.title := pg_catalog.btrim(new.title);
  new.description := nullif(pg_catalog.btrim(new.description), '');
  new.lost_reason := nullif(pg_catalog.btrim(new.lost_reason), '');
  -- the stage's default probability (10/25/50/75/100/0, as in src/lib/domain/pipeline.ts)
  stage_default := (case new.stage when 'new' then 10 when 'qualified' then 25 when 'proposal' then 50 when 'negotiation' then 75 when 'won' then 100 when 'lost' then 0 end)::smallint;
  if tg_op = 'INSERT' then
    if new.probability_percent is null then
      new.probability_percent := stage_default;
    end if;
  elsif new.stage is distinct from old.stage and new.probability_percent is not distinct from old.probability_percent then
    new.probability_percent := stage_default;
  end if;
  return new;
end;
$$;
drop function private.stage_default_probability(text);
