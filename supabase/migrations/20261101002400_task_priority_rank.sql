-- SIT-229: a sortable rank for task priority. Sorting by the text column would give high, low, medium, urgent; the
-- defined order is urgent > high > medium > low. A stored generated column keeps the rank in the database (one definition,
-- indexable, usable by PostgREST ordering) and nobody can write it.
alter table public.tasks
  add column priority_rank smallint generated always as (
    case priority when 'urgent' then 4 when 'high' then 3 when 'medium' then 2 else 1 end
  ) stored;
comment on column public.tasks.priority_rank is 'urgent 4, high 3, medium 2, low 1. Generated from priority; sort descending for most urgent first.';
create index tasks_org_priority_rank_idx on public.tasks (organization_id, priority_rank desc, due_date);
