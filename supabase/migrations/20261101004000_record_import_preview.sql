-- SIT-231: records a customer CSV preview as an import job (PRD 6.2, 7.4, US-10).
-- Clients cannot write import_jobs (SIT-223), so the preview endpoint calls this function. It runs as the table owner (SECURITY DEFINER,
-- search_path pinned, EXECUTE for `authenticated` only) and checks the caller itself:
--   * signed in, a member of the workspace (anything else is "not found"), a writer role (owner, admin, member), workspace not expired;
--   * repeat protection: the same file (SHA-256) in the same workspace within the window (one hour) returns the SAME job instead of a new
--     one (an earlier preview that has not expired, or an import that already committed); concurrent identical uploads are serialized by an
--     advisory lock, so two requests at once still produce one job;
--   * counts and the error summary are validated by the table's own constraints (row numbers and codes only, at most 20,000 bytes).
-- It returns the job and, for a demo workspace, how many more customers fit under the demo cap (null for a real workspace), so the preview can warn.
create or replace function public.record_import_preview(
  p_org_id uuid,
  p_file_sha256 text,
  p_total_rows integer,
  p_rejected_rows integer,
  p_error_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  window_start constant interval := interval '1 hour';
  existing public.import_jobs;
  job public.import_jobs;
  reused boolean := false;
  org_kind text;
  cap integer;
  remaining integer := null;
begin
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to continue.', detail = 'NOT_SIGNED_IN';
  end if;
  if p_org_id is null or not private.is_member(p_org_id) then
    raise exception using errcode = 'OD404', message = 'That workspace was not found.', detail = 'ORGANIZATION_NOT_FOUND';
  end if;
  if not private.has_role(p_org_id, array['owner', 'admin', 'member']) then
    raise exception using errcode = 'OD403', message = 'Your role cannot import customers.', detail = 'FORBIDDEN';
  end if;
  if not private.org_is_writable(p_org_id) then
    raise exception using errcode = 'OD403', message = 'This demo has expired. Start a new one to keep exploring.', detail = 'DEMO_EXPIRED';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'OD422', message = 'The file hash is not valid.', detail = 'IMPORT_HASH_INVALID';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_org_id::text || ':' || p_file_sha256, 0));

  select j.* into existing from public.import_jobs j
    where j.organization_id = p_org_id and j.file_sha256 = p_file_sha256
      and j.created_at > pg_catalog.now() - window_start
      and (j.status = 'committed' or (j.status = 'previewed' and j.expires_at > pg_catalog.now()))
    order by j.created_at desc limit 1;
  if found then
    job := existing;
    reused := true;
  else
    insert into public.import_jobs (organization_id, file_sha256, total_rows, rejected_rows, error_summary)
    values (p_org_id, p_file_sha256, p_total_rows, p_rejected_rows, coalesce(p_error_summary, '[]'::jsonb))
    returning * into job;
  end if;

  select o.kind into org_kind from public.organizations o where o.id = p_org_id;
  if org_kind = 'demo' then
    cap := private.app_limit('demo_cap_customers');
    select greatest(cap - pg_catalog.count(*), 0)::integer into remaining from public.customers c where c.organization_id = p_org_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', job.id, 'status', job.status, 'fileSha256', job.file_sha256, 'totalRows', job.total_rows, 'rejectedRows', job.rejected_rows,
    'importedRows', job.imported_rows, 'createdAt', job.created_at, 'expiresAt', job.expires_at, 'reused', reused, 'demoRemaining', remaining
  );
end;
$$;

revoke all on function public.record_import_preview(uuid, text, integer, integer, jsonb) from public, anon;
grant execute on function public.record_import_preview(uuid, text, integer, integer, jsonb) to authenticated;
