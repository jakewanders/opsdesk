import { escapeCsvCell } from "@/lib/csv/write";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan } from "@/lib/permissions";
import type { OrgContext } from "@/lib/api/org-context";
import type { Database } from "@/lib/supabase/database.types";
import { ApiError, NotFoundError, ValidationError } from "@/lib/api/errors";
import {
  analyzeCustomerCsv,
  ImportFileError,
  MAX_LISTED_ISSUES,
  storedErrorSummary,
  type ImportAnalysis,
} from "./analyze";
import {
  commitRows,
  findExistingEmails,
  findImportJob,
  recordPreview,
  type CommitRow,
} from "./repository";
import { decodeUpload } from "./upload";

type Client = SupabaseClient<Database>;

/** Raised for a file that cannot be previewed at all; row-level problems are part of the preview instead. */
function refuse(error: ImportFileError): never {
  throw new ValidationError(error.message, undefined, `IMPORT_${error.code}`);
}

export function analyse(text: string, existing: ReadonlySet<string>): ImportAnalysis {
  try {
    return analyzeCustomerCsv(text, existing);
  } catch (e) {
    if (e instanceof ImportFileError) refuse(e);
    throw e;
  }
}

/**
 * Previews a customer CSV: parses and validates every row without writing a single customer, stores the preview as an import job
 * (or returns the job already made for the same file within the hour), and answers with the first rows, the counts and the exact
 * errors. Owner, admin and member only.
 */
export async function previewCustomerImport(
  supabase: Client,
  ctx: OrgContext,
  contentBase64: string,
) {
  assertCan(ctx.role, ctx.kind, "records.write");
  const { text, fileSha256 } = decodeUpload(contentBase64);

  // First pass finds the e-mails worth looking up; the second adds the "already in this workspace" warnings.
  let analysis = analyse(text, new Set());
  const emails = [
    ...new Set(analysis.valid.map((v) => v.input.email).filter((e): e is string => !!e)),
  ];
  if (emails.length > 0) {
    const existing = await findExistingEmails(supabase, ctx.org.id, emails);
    if (existing.size > 0) analysis = analyse(text, existing);
  }

  const job = await recordPreview(
    supabase,
    ctx.org.id,
    fileSha256,
    analysis.totalRows,
    analysis.invalidRows,
    storedErrorSummary(analysis),
  );

  const demo =
    job.demoRemaining === null
      ? null
      : { remaining: job.demoRemaining, wouldExceed: analysis.validRows > job.demoRemaining };

  return {
    reused: job.reused,
    data: {
      importJobId: job.id,
      status: job.status,
      fileSha256,
      expiresAt: job.expiresAt,
      counts: {
        total: analysis.totalRows,
        valid: analysis.validRows,
        invalid: analysis.invalidRows,
      },
      columns: analysis.columns,
      rows: analysis.rows,
      errors: analysis.errors.slice(0, MAX_LISTED_ISSUES),
      errorsTruncated: analysis.errors.length > MAX_LISTED_ISSUES,
      warnings: analysis.warnings.slice(0, MAX_LISTED_ISSUES),
      warningsTruncated: analysis.warnings.length > MAX_LISTED_ISSUES,
      demo,
    },
  };
}

const toCommitRow = (row: number, input: ImportAnalysis["valid"][number]["input"]): CommitRow => ({
  src_row: row,
  type: input.type,
  display_name: input.displayName,
  company_name: input.companyName,
  email: input.email,
  phone: input.phone,
  website: input.website,
  status: input.status,
  source: input.source,
  tags: input.tags,
  notes: input.notes,
});

/**
 * Commits a previewed import: re-reads the uploaded file, checks it is the file the job was made from, re-validates every row, and hands
 * the valid ones to `commit_customer_import`, which writes them once (see that migration for the chunk and failure rule). Invalid rows
 * are skipped. A job that already finished returns its stored result. In a demo workspace that reaches its customer cap the answer is
 * 429 `DEMO_CAP` with the partial result in `error.meta.result`.
 */
export async function commitCustomerImport(
  supabase: Client,
  ctx: OrgContext,
  input: { importJobId: string; content: string },
) {
  assertCan(ctx.role, ctx.kind, "records.write");
  const { text, fileSha256 } = decodeUpload(input.content);
  const job = await findImportJob(supabase, ctx.org.id, input.importJobId);
  if (!job) throw new NotFoundError("That import was not found.", "IMPORT_JOB_NOT_FOUND");
  if (job.file_sha256 !== fileSha256)
    throw new ValidationError(
      "This is not the file that was previewed. Upload the same file again to import it.",
      undefined,
      "IMPORT_FILE_MISMATCH",
    );
  // A finished job needs no rows: the database returns what it recorded.
  const rows =
    job.status === "previewed"
      ? analyse(text, new Set()).valid.map((v) => toCommitRow(v.row, v.input))
      : [];
  const result = await commitRows(supabase, job.id, rows);
  if (result.demoCapReached) {
    throw new ApiError(
      429,
      "DEMO_CAP",
      `Demo limit reached: customers. Imported ${result.imported} of ${result.total - result.rejected} valid rows.`,
      undefined,
      undefined,
      { result },
    );
  }
  return result;
}

const REPORT_MESSAGES: Record<string, string> = {
  REQUIRED: "A required value is missing.",
  WRONG_LENGTH: "The value is too short or too long.",
  INVALID_EMAIL: "Not a valid email address.",
  INVALID_CHOICE: "Not one of the allowed values.",
  INVALID_FORMAT: "The value is not in the expected format.",
  INVALID_VALUE: "The value is not allowed.",
  INVALID_CHARACTERS: "Contains unsupported characters.",
  SINGLE_LINE_ONLY: "Must be on a single line.",
  NO_HTML: "HTML is not allowed.",
  TOO_MANY_CELLS: "The row has more cells than the header.",
  TOO_SHORT: "Too short.",
  TOO_LONG: "Too long.",
  INVALID: "The value is not valid.",
  DUPLICATE_SKIPPED:
    "Skipped: this email address is already in the workspace or earlier in the file.",
  COMMIT_FAILED: "Not imported: saving this group of rows failed. Import the file again to retry.",
  REPORT_TRUNCATED: "More problems exist than are listed here.",
};

const csvCell = escapeCsvCell;

/**
 * The error report of an import job as CSV: row number, field, code and a fixed explanation. Built from the job's stored summary, which
 * holds row numbers, field names and codes only, so the report never repeats anything a user typed into the file.
 */
export async function importErrorReport(supabase: Client, ctx: OrgContext, jobId: string) {
  assertCan(ctx.role, ctx.kind, "records.read");
  const job = await findImportJob(supabase, ctx.org.id, jobId);
  if (!job) throw new NotFoundError("That import was not found.", "IMPORT_JOB_NOT_FOUND");
  const summary = (job.error_summary ?? {}) as {
    errors?: Array<{ row: number; field: string | null; code: string }>;
    truncated?: boolean;
    extra?: Array<{ row: number; field: string | null; code: string }>;
    result?: { skippedDuplicates?: number; failedRows?: number };
  };
  const lines = [...(summary.errors ?? []), ...(summary.extra ?? [])].sort((a, b) => a.row - b.row);
  const expectedExtra =
    (summary.result?.skippedDuplicates ?? 0) + (summary.result?.failedRows ?? 0);
  const truncated = Boolean(summary.truncated) || expectedExtra > (summary.extra?.length ?? 0);
  const out = ["row,field,code,explanation"];
  for (const l of lines)
    out.push([l.row, l.field, l.code, REPORT_MESSAGES[l.code] ?? l.code].map(csvCell).join(","));
  if (truncated)
    out.push(["", "", "REPORT_TRUNCATED", REPORT_MESSAGES.REPORT_TRUNCATED].map(csvCell).join(","));
  return { csv: out.join("\r\n") + "\r\n", truncated, jobId: job.id };
}
