import type { ImportAnalysis, RowIssue } from "./analyze";

/** What `POST /imports/customers/preview` answers (the `data` part). */
export type ImportPreview = {
  importJobId: string;
  status: "previewed" | "committed" | "failed" | "expired";
  fileSha256: string;
  expiresAt: string;
  counts: { total: number; valid: number; invalid: number };
  columns: ImportAnalysis["columns"];
  rows: ImportAnalysis["rows"];
  errors: RowIssue[];
  errorsTruncated: boolean;
  warnings: RowIssue[];
  warningsTruncated: boolean;
  demo: { remaining: number; wouldExceed: boolean } | null;
};

/** What `POST /imports/customers/commit` answers (also in `error.meta.result` of a demo cap 429). */
export type ImportResult = {
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

/** How many rows of a previewed file will really be imported, and why the others will not. Pure, from the preview alone. */
export function planImport(
  preview: Pick<ImportPreview, "counts" | "warnings" | "warningsTruncated" | "demo">,
) {
  const duplicateRows = new Set(
    preview.warnings
      .filter((w) => w.code === "DUPLICATE_IN_FILE" || w.code === "DUPLICATE_EXISTING")
      .map((w) => w.row),
  ).size;
  const afterDuplicates = Math.max(preview.counts.valid - duplicateRows, 0);
  const willImport = preview.demo
    ? Math.min(afterDuplicates, preview.demo.remaining)
    : afterDuplicates;
  return {
    invalid: preview.counts.invalid,
    duplicateRows,
    /** The list of warnings is capped; when it was, the duplicate count is a floor. */
    duplicatesApproximate: preview.warningsTruncated,
    overDemoCap: preview.demo ? Math.max(afterDuplicates - preview.demo.remaining, 0) : 0,
    willImport,
  };
}
