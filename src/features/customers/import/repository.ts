import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;

/** Of `emails` (lower-case), the ones some customer of the workspace already has (archived included). Chunked to keep each request short. */
export async function findExistingEmails(
  supabase: Client,
  orgId: string,
  emails: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    const { data, error } = await supabase
      .from("customers")
      .select("email")
      .eq("organization_id", orgId)
      .in("email", chunk);
    if (error) throw error;
    for (const row of data ?? []) if (row.email) found.add(row.email);
  }
  return found;
}

export type RecordedPreview = {
  id: string;
  status: "previewed" | "committed" | "failed" | "expired";
  fileSha256: string;
  totalRows: number;
  rejectedRows: number;
  importedRows: number;
  createdAt: string;
  expiresAt: string;
  reused: boolean;
  demoRemaining: number | null;
};

/** Stores the preview as an import job, or returns the existing job for the same file (see `record_import_preview`). */
export async function recordPreview(
  supabase: Client,
  orgId: string,
  fileSha256: string,
  totalRows: number,
  rejectedRows: number,
  errorSummary: Json,
): Promise<RecordedPreview> {
  const { data, error } = await supabase.rpc("record_import_preview", {
    p_org_id: orgId,
    p_file_sha256: fileSha256,
    p_total_rows: totalRows,
    p_rejected_rows: rejectedRows,
    p_error_summary: errorSummary,
  });
  if (error) throw error;
  return data as unknown as RecordedPreview;
}

export type ImportJobRow = {
  id: string;
  file_sha256: string;
  status: "previewed" | "committed" | "failed" | "expired";
  total_rows: number;
  imported_rows: number;
  rejected_rows: number;
  error_summary: Json;
  created_at: string;
};

/** A job of the workspace (RLS: members read), or null: a missing job and another workspace's look the same. */
export async function findImportJob(
  supabase: Client,
  orgId: string,
  jobId: string,
): Promise<ImportJobRow | null> {
  const { data, error } = await supabase
    .from("import_jobs")
    .select(
      "id, file_sha256, status, total_rows, imported_rows, rejected_rows, error_summary, created_at",
    )
    .eq("organization_id", orgId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ImportJobRow | null) ?? null;
}

/** One valid row as `commit_customer_import` reads it (snake_case, with its spreadsheet row number). */
export type CommitRow = {
  src_row: number;
  type: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  status: string;
  source: string;
  tags: string[];
  notes: string | null;
};

export type CommitResult = {
  importJobId: string;
  status: "committed" | "failed";
  replayed: boolean;
  total: number;
  imported: number;
  rejected: number;
  skippedDuplicates: number;
  failedChunks: number[];
  failedRows: number;
  demoCapReached: boolean;
  notImportedDemoCap: number;
};

/** Writes the rows in chunks inside one database call and finishes the job (see `commit_customer_import`). */
export async function commitRows(
  supabase: Client,
  jobId: string,
  rows: CommitRow[],
): Promise<CommitResult> {
  const { data, error } = await supabase.rpc("commit_customer_import", {
    p_job_id: jobId,
    p_rows: rows as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as CommitResult;
}
