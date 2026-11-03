import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan } from "@/lib/permissions";
import type { OrgContext } from "@/lib/api/org-context";
import type { Database } from "@/lib/supabase/database.types";
import { PayloadTooLargeError, ValidationError } from "@/lib/api/errors";
import {
  analyzeCustomerCsv,
  IMPORT_MAX_BYTES,
  ImportFileError,
  MAX_LISTED_ISSUES,
  storedErrorSummary,
  type ImportAnalysis,
} from "./analyze";
import { findExistingEmails, recordPreview } from "./repository";

type Client = SupabaseClient<Database>;

/** Decodes the uploaded bytes as strict UTF-8 (a byte-order mark is dropped; invalid sequences are refused, never replaced). */
function decodeCsv(bytes: Buffer): string {
  if (bytes.length === 0)
    throw new ValidationError("The file is empty.", undefined, "IMPORT_EMPTY_FILE");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationError(
      "The file is not UTF-8 text. In your spreadsheet, export or save it as CSV (UTF-8).",
      undefined,
      "IMPORT_NOT_UTF8",
    );
  }
}

/** Raised for a file that cannot be previewed at all; row-level problems are part of the preview instead. */
function refuse(error: ImportFileError): never {
  throw new ValidationError(error.message, undefined, `IMPORT_${error.code}`);
}

function analyse(text: string, existing: ReadonlySet<string>): ImportAnalysis {
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
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length > IMPORT_MAX_BYTES)
    throw new PayloadTooLargeError("The file is larger than 2 MB. Split it into smaller files.");
  const text = decodeCsv(bytes);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");

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
