-- SIT-223: import_jobs, the record of a customer CSV import (PRD 6.2, US-10).
-- A preview creates a job (status "previewed", valid for one hour); the commit endpoint (SIT-239) completes it. The job holds
-- counts and an error summary of row numbers and error codes ONLY, never row contents, so a leaked job reveals no customer data.
-- CLIENTS DO NOT WRITE THIS TABLE. `authenticated` has SELECT only (members read their organization's jobs); the preview and
-- commit functions write it, so a client cannot set a count or a status. The checks below hold for any writer.

create table public.import_jobs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  created_by uuid default auth.uid(),
  file_sha256 text not null,
  status text not null default 'previewed',
  total_rows integer not null default 0,
  imported_rows integer not null default 0,
  rejected_rows integer not null default 0,
  error_summary jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  -- a preview that is never committed stops being usable after this time (one hour by default)
  expires_at timestamptz not null default (now() + interval '1 hour'),
  completed_at timestamptz,
  constraint import_jobs_pkey primary key (id),
  constraint import_jobs_org_id_key unique (organization_id, id),
  constraint import_jobs_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint import_jobs_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null,
  constraint import_jobs_sha256_format check (file_sha256 ~ '^[0-9a-f]{64}$'),
  constraint import_jobs_status_values check (status in ('previewed', 'committed', 'failed', 'expired')),
  constraint import_jobs_counts_range check (
    total_rows between 0 and 10000 and imported_rows between 0 and 10000 and rejected_rows between 0 and 10000
  ),
  constraint import_jobs_counts_add_up check (imported_rows + rejected_rows <= total_rows),
  -- a job that was only previewed has imported nothing
  constraint import_jobs_previewed_imported_nothing check (status <> 'previewed' or imported_rows = 0),
  -- error_summary is a list of {row, code} entries (or a small object of counts): numbers and codes, capped in size
  constraint import_jobs_error_summary_shape check (jsonb_typeof(error_summary) in ('array', 'object')),
  constraint import_jobs_error_summary_size check (pg_catalog.octet_length(error_summary::text) <= 20000),
  constraint import_jobs_completed_matches_status check ((status = 'previewed') = (completed_at is null)),
  constraint import_jobs_expiry_after_creation check (expires_at > created_at)
);

-- The repeat-protection lookup: "has this organization imported this exact file recently?" (newest first).
create index import_jobs_org_file_created_idx on public.import_jobs (organization_id, file_sha256, created_at desc);
-- Cleanup scans previews past their expiry.
create index import_jobs_previewed_expiry_idx on public.import_jobs (expires_at) where status = 'previewed';

comment on table public.import_jobs is 'Customer CSV import jobs: counts and row-number/error-code summaries only. Written only by the import functions.';
comment on column public.import_jobs.error_summary is 'Row numbers and error codes only. Never row contents. At most 20000 bytes of JSON.';

-- A job leaves "previewed" once: to committed, failed or expired. A finished job never changes again, and the
-- counts, the file hash and the owner never change after the preview created them.
create or replace function private.guard_import_job_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'previewed' then
    raise exception using errcode = 'OD409', message = pg_catalog.format('An import that is %s cannot change.', old.status), detail = 'IMPORT_JOB_FINISHED';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_import_job_state() from public, anon, authenticated;

create trigger import_jobs_guard_state before update on public.import_jobs for each row execute function private.guard_import_job_state();
select private.protect_columns('public.import_jobs', 'id', 'organization_id', 'created_by', 'file_sha256', 'total_rows', 'created_at', 'expires_at');

-- ---------------------------------------------------------------------------------------------
-- Access: members read; nobody writes directly.
-- ---------------------------------------------------------------------------------------------
select private.attach_tenant_rls('public.import_jobs');
drop policy import_jobs_insert_writer on public.import_jobs;
drop policy import_jobs_update_writer on public.import_jobs;
drop policy import_jobs_delete_writer on public.import_jobs;
revoke insert, update, delete, truncate, references, trigger on table public.import_jobs from authenticated;

-- Previews are written by a real workspace's writers only in practice, but a demo workspace may import too: bound them.
insert into private.app_limits (key, value, note) values
  ('demo_cap_import_jobs', 10, 'Most import jobs in one demo workspace.');
select private.attach_demo_cap('public.import_jobs', 'demo_cap_import_jobs');

-- Who may commit a job: its creator (when they can still write) or an owner or admin of the organization. The commit
-- function (SIT-239) calls this; it is here so the rule lives next to the table.
create or replace function private.can_commit_import_job(job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.import_jobs j
    where j.id = job_id
      and private.can_write(j.organization_id)
      and (j.created_by = auth.uid() or private.has_role(j.organization_id, array['owner', 'admin']))
  )
$$;
-- Not callable by API roles (only the row-level-security helpers are): the commit function runs as its owner and calls it.
revoke all on function private.can_commit_import_job(uuid) from public, anon, authenticated;
grant execute on function private.can_commit_import_job(uuid) to service_role;

-- Cleanup: previews past their expiry become "expired"; expired jobs older than the retention are removed.
-- Returns how many were marked and how many were removed. Called by the cleanup job (service_role only).
create or replace function public.cleanup_expire_import_previews(retain interval default interval '1 day')
returns table (expired integer, removed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  marked integer;
  gone integer;
begin
  update public.import_jobs j set status = 'expired', completed_at = pg_catalog.now()
    where j.status = 'previewed' and j.expires_at <= pg_catalog.now();
  get diagnostics marked = row_count;
  delete from public.import_jobs j where j.status = 'expired' and j.completed_at <= pg_catalog.now() - retain;
  get diagnostics gone = row_count;
  return query select marked, gone;
end;
$$;
revoke all on function public.cleanup_expire_import_previews(interval) from public, anon, authenticated;
grant execute on function public.cleanup_expire_import_previews(interval) to service_role;
