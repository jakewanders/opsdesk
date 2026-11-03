-- SIT-239: writes a previewed customer CSV, exactly once (PRD 7.4, US-10).
-- The API re-reads the uploaded file, re-validates every row, and sends the VALID rows here (each with its spreadsheet row number).
-- This function runs as the table owner (SECURITY DEFINER, search_path pinned, EXECUTE for `authenticated` only) and checks the caller itself:
-- signed in, a member, a writer role, an unexpired workspace, and the right to commit THIS job (its creator, or an owner or admin).
--
-- THE RULE (documented in docs/DECISIONS.md): the job row is locked for the whole call, so two commits of one job run one after the other and
-- the second one finds a finished job and returns its stored result (nothing is written twice). Rows are inserted in chunks of 100; each
-- chunk is its own subtransaction, so a chunk that fails is rolled back ALONE: earlier chunks stay, later chunks still run, and the failed
-- chunk's rows are reported (`failedChunks`, `failedRows`). The job moves previewed -> committed (or -> failed when every attempt failed and
-- nothing was imported) in the same transaction as the inserts. Skipped, not failed: a row whose e-mail is already in the workspace, or is
-- repeated earlier in the same chunk or file. A demo workspace stops at its customer cap: the rows that do not fit are counted in
-- `notImportedDemoCap` and `demoCapReached` is true. One `imported` activity event summarizes the import; each customer also gets the
-- normal `created` event from the table's trigger (a real workspace has no activity cap; a demo is limited to 50 customers).
create or replace function public.commit_customer_import(p_job_id uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  chunk_size constant integer := 100;
  job public.import_jobs;
  org uuid;
  org_kind text;
  valid_rows integer;
  n_rows integer;
  cap_left integer := null;
  total_chunks integer;
  chunk jsonb;
  i integer;
  chunk_len integer;
  src_n integer;
  fresh_n integer;
  ins_n integer;
  dup_rows integer[];
  imported integer := 0;
  skipped integer := 0;
  capped integer := 0;
  failed_rows integer := 0;
  failed_chunks integer[] := '{}';
  cap_hit boolean := false;
  extra jsonb := '[]'::jsonb;
  extra_count integer := 0;
  r integer;
  summary jsonb;
  result jsonb;
  new_status text;
begin
  select j.* into job from public.import_jobs j where j.id = p_job_id for update;
  if uid is null then
    raise exception using errcode = 'OD403', message = 'Sign in to continue.', detail = 'NOT_SIGNED_IN';
  end if;
  if not found or not private.is_member(job.organization_id) then
    raise exception using errcode = 'OD404', message = 'That import was not found.', detail = 'IMPORT_JOB_NOT_FOUND';
  end if;
  org := job.organization_id;
  if not private.has_role(org, array['owner', 'admin', 'member']) then
    raise exception using errcode = 'OD403', message = 'Your role cannot import customers.', detail = 'FORBIDDEN';
  end if;
  if not private.org_is_writable(org) then
    raise exception using errcode = 'OD403', message = 'This demo has expired. Start a new one to keep exploring.', detail = 'DEMO_EXPIRED';
  end if;
  if not private.can_commit_import_job(p_job_id) then
    raise exception using errcode = 'OD403', message = 'Only the person who started this import, or an owner or admin, can finish it.', detail = 'FORBIDDEN';
  end if;

  -- A finished job returns what it recorded; nothing is written again.
  if job.status in ('committed', 'failed') then
    return pg_catalog.jsonb_build_object('importJobId', job.id, 'status', job.status, 'replayed', true) || coalesce(job.error_summary -> 'result', '{}'::jsonb);
  end if;
  if job.status = 'expired' or job.expires_at <= pg_catalog.now() then
    raise exception using errcode = 'OD409', message = 'This preview has expired. Upload the file again to start a new import.', detail = 'IMPORT_JOB_EXPIRED';
  end if;

  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = 'OD422', message = 'The rows must be a list.', detail = 'IMPORT_ROWS_INVALID';
  end if;
  n_rows := pg_catalog.jsonb_array_length(p_rows);
  valid_rows := job.total_rows - job.rejected_rows;
  if n_rows > valid_rows then
    raise exception using errcode = 'OD422', message = 'The file has more valid rows than the preview found. Upload it again.', detail = 'IMPORT_ROWS_MISMATCH';
  end if;

  select o.kind into org_kind from public.organizations o where o.id = org;
  if org_kind = 'demo' then
    select greatest(private.app_limit('demo_cap_customers') - pg_catalog.count(*), 0)::integer into cap_left from public.customers c where c.organization_id = org;
  end if;

  total_chunks := (n_rows + chunk_size - 1) / chunk_size;
  for i in 1..total_chunks loop
    chunk := (select pg_catalog.jsonb_agg(e.value order by e.ord) from pg_catalog.jsonb_array_elements(p_rows) with ordinality as e(value, ord)
              where e.ord > (i - 1) * chunk_size and e.ord <= i * chunk_size);
    chunk_len := pg_catalog.jsonb_array_length(chunk);
    begin
      with src as (
        select * from pg_catalog.jsonb_to_recordset(chunk)
          as s(src_row integer, type text, display_name text, company_name text, email text, phone text, website text, status text, source text, tags jsonb, notes text)
      ),
      dup as (
        select s.src_row from src s
        where s.email is not null
          and (exists (select 1 from public.customers c where c.organization_id = org and c.email = s.email)
               or exists (select 1 from src t where t.email = s.email and t.src_row < s.src_row))
      ),
      fresh as (select s.* from src s where s.src_row not in (select d.src_row from dup d)),
      ins as (
        insert into public.customers (organization_id, created_by, type, display_name, company_name, email, phone, website, status, source, tags, notes)
        select org, uid, f.type, f.display_name, f.company_name, f.email, f.phone, f.website, f.status, f.source,
               coalesce(array(select pg_catalog.jsonb_array_elements_text(f.tags)), '{}'::text[]), f.notes
        from fresh f order by f.src_row limit coalesce(cap_left, 2147483647)
        returning 1
      )
      select (select pg_catalog.count(*) from src), (select pg_catalog.count(*) from fresh), (select pg_catalog.count(*) from ins),
             array(select d.src_row from dup d order by d.src_row)
        into src_n, fresh_n, ins_n, dup_rows;
    exception when others then
      if sqlstate = 'OD429' then
        cap_hit := true;
        capped := capped + chunk_len;
      else
        failed_chunks := failed_chunks || i;
        failed_rows := failed_rows + chunk_len;
        for r in select (e ->> 'src_row')::integer from pg_catalog.jsonb_array_elements(chunk) e loop
          if extra_count < 100 then
            extra := extra || pg_catalog.jsonb_build_object('row', r, 'field', null, 'code', 'COMMIT_FAILED');
            extra_count := extra_count + 1;
          end if;
        end loop;
      end if;
      if cap_hit then
        capped := capped + greatest(n_rows - i * chunk_size, 0);
        exit;
      end if;
      continue;
    end;
    imported := imported + ins_n;
    skipped := skipped + (src_n - fresh_n);
    foreach r in array dup_rows loop
      if extra_count < 100 then
        extra := extra || pg_catalog.jsonb_build_object('row', r, 'field', 'email', 'code', 'DUPLICATE_SKIPPED');
        extra_count := extra_count + 1;
      end if;
    end loop;
    if cap_left is not null then
      cap_left := cap_left - ins_n;
      if fresh_n > ins_n then
        cap_hit := true;
        capped := capped + (fresh_n - ins_n) + greatest(n_rows - i * chunk_size, 0);
        exit;
      end if;
    end if;
  end loop;

  new_status := case when imported = 0 and pg_catalog.cardinality(failed_chunks) > 0 then 'failed' else 'committed' end;
  result := pg_catalog.jsonb_build_object(
    'total', job.total_rows, 'imported', imported, 'rejected', job.rejected_rows, 'skippedDuplicates', skipped,
    'failedChunks', pg_catalog.to_jsonb(failed_chunks), 'failedRows', failed_rows,
    'demoCapReached', cap_hit, 'notImportedDemoCap', capped
  );
  summary := case when pg_catalog.jsonb_typeof(job.error_summary) = 'object' then job.error_summary else '{}'::jsonb end;
  summary := summary || pg_catalog.jsonb_build_object('result', result, 'extra', extra);
  update public.import_jobs set status = new_status, imported_rows = imported, completed_at = pg_catalog.now(), error_summary = summary where id = job.id;

  perform private.log_activity(
    org, 'customer', job.id, 'imported',
    pg_catalog.format('%s imported %s %s from a CSV file', private.activity_actor_name(), imported, case when imported = 1 then 'customer' else 'customers' end),
    pg_catalog.jsonb_build_object('imported', imported, 'skipped', skipped, 'rejected', job.rejected_rows)
  );

  return pg_catalog.jsonb_build_object('importJobId', job.id, 'status', new_status, 'replayed', false) || result;
end;
$$;

revoke all on function public.commit_customer_import(uuid, jsonb) from public, anon;
grant execute on function public.commit_customer_import(uuid, jsonb) to authenticated;
