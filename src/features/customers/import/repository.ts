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
