"use client";

import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  Download,
  FileSpreadsheet,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { notify } from "@/components/shared/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { apiDownload, isClientApiError } from "@/lib/api-client/api-fetch";
import { createSingleFlight } from "@/lib/api-client/idempotency";
import { useApi, useClearApiCache } from "@/lib/api-client/provider";
import { saveBlob } from "@/lib/api-client/save-file";
import { cn } from "@/lib/utils";
import { bytesToBase64, checkChosenFile } from "../encode";
import { planImport, type ImportPreview, type ImportResult } from "../types";

type Step = "upload" | "review" | "result";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "upload", label: "Choose a file" },
  { id: "review", label: "Review" },
  { id: "result", label: "Done" },
];
const FIELD_LABELS: Record<string, string> = {
  displayName: "Name",
  type: "Type",
  companyName: "Company",
  email: "Email",
  phone: "Phone",
  website: "Website",
  status: "Status",
  source: "Source",
  tags: "Tags",
  notes: "Notes",
};
const label = (field: string | null) => (field ? (FIELD_LABELS[field] ?? field) : "Whole row");
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The customer CSV import (PRD US-10, F14): choose a file, review what will happen, import, see the result. Three steps with a
 * keyboard-reachable list of them; focus moves to each step's heading and problems are announced. The file is held in memory only
 * (never stored by the browser) and re-sent on import so the server can check it again. The server decides everything; the checks
 * here (type, size) only save a round trip. Import is single-flight with one idempotency key per intent, so a double click or a
 * retry after a network failure imports once.
 */
export function ImportWizard({ isDemo }: { isDemo: boolean }) {
  const { fetch: call, organizationId } = useApi();
  const clearCache = useClearApiCache();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<{ name: string; size: number; content: string } | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const flight = useRef(createSingleFlight<ImportResult>());
  const plan = useMemo(() => (preview ? planImport(preview) : null), [preview]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  async function choose(chosen: File | undefined | null) {
    setPickError(null);
    setFailure(null);
    if (!chosen) return;
    const problem = checkChosenFile(chosen);
    if (problem) {
      setFile(null);
      setPickError(problem);
      return;
    }
    const bytes = new Uint8Array(await chosen.arrayBuffer());
    setFile({ name: chosen.name, size: chosen.size, content: bytesToBase64(bytes) });
  }

  async function runPreview() {
    if (!file || busy) return;
    setBusy("preview");
    setFailure(null);
    try {
      const res = await call<ImportPreview>("/imports/customers/preview", {
        method: "POST",
        json: { content: file.content },
      });
      setPreview(res.data);
      flight.current = createSingleFlight<ImportResult>();
      setStep("review");
    } catch (error) {
      setFailure(
        isClientApiError(error)
          ? {
              title: "The file could not be checked",
              message: error.message,
              requestId: error.requestId,
            }
          : { title: "The file could not be checked", message: "Something went wrong. Try again." },
      );
    } finally {
      setBusy(null);
    }
  }

  async function runImport() {
    if (!file || !preview || busy) return;
    setBusy("import");
    setFailure(null);
    try {
      const done = await flight.current.run(async (key) => {
        const res = await call<ImportResult>("/imports/customers/commit", {
          method: "POST",
          json: { importJobId: preview.importJobId, content: file.content },
          idempotencyKey: key,
        });
        return res.data;
      });
      finish(done);
    } catch (error) {
      // a demo that reached its customer cap answers 429 with what it did manage to import
      const partial =
        isClientApiError(error) && error.code === "DEMO_CAP"
          ? (error.meta?.result as ImportResult | undefined)
          : undefined;
      if (partial) {
        finish(partial);
      } else {
        setFailure(
          isClientApiError(error)
            ? {
                title: "The import did not finish",
                message: `${error.message} Try again: nothing is imported twice.`,
                requestId: error.requestId,
              }
            : {
                title: "The import did not finish",
                message: "Something went wrong. Try again: nothing is imported twice.",
              },
        );
      }
    } finally {
      setBusy(null);
    }
  }

  function finish(done: ImportResult) {
    setResult(done);
    setStep("result");
    clearCache();
    if (!done.replayed)
      notify.success("Import finished", `${plural(done.imported, "customer")} added.`);
  }

  async function downloadReport() {
    const id = result?.importJobId ?? preview?.importJobId;
    if (!id) return;
    try {
      const { blob, filename } = await apiDownload(`/imports/customers/${id}/errors`, {
        organizationId,
      });
      saveBlob(blob, filename ?? "import-errors.csv");
    } catch (error) {
      notify.error(
        "The report could not be downloaded",
        isClientApiError(error) ? error.message : "Try again.",
      );
    }
  }

  function startOver() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setFailure(null);
    setPickError(null);
    flight.current = createSingleFlight<ImportResult>();
    setStep("upload");
  }

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Import customers</h1>
        <ol aria-label="Import steps" className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {STEPS.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === stepIndex ? "step" : undefined}
              className={cn(
                "flex items-center gap-2",
                i === stepIndex ? "font-semibold" : "text-muted-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-6 place-items-center rounded-full border text-xs",
                  i === stepIndex
                    ? "border-foreground bg-foreground text-background"
                    : "border-border",
                )}
              >
                {i + 1}
              </span>
              <span>
                {s.label}
                {i < stepIndex ? <span className="sr-only"> (done)</span> : null}
                {i === stepIndex ? <span className="sr-only"> (current step)</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </header>

      {failure ? (
        <ErrorAlert title={failure.title} message={failure.message} requestId={failure.requestId} />
      ) : null}

      {step === "upload" ? (
        <section aria-labelledby="step-upload" className="flex flex-col gap-5">
          <h2
            id="step-upload"
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            Choose a CSV file
          </h2>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void choose(e.dataTransfer.files[0]);
            }}
            className={cn(
              "flex flex-col items-start gap-3 rounded-lg border-2 border-dashed border-border p-5",
              dragging && "border-ring bg-muted/50",
            )}
          >
            <Upload aria-hidden="true" className="size-6 text-muted-foreground" />
            <div className="flex flex-col gap-1 text-sm">
              <label htmlFor="import-file" className="font-medium">
                CSV file
              </label>
              <span id="import-file-hint" className="text-muted-foreground">
                Drag a file onto this box, or choose one. Up to 1,000 customers and 2 MB, saved as
                CSV (UTF-8).
              </span>
            </div>
            <input
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              aria-describedby={
                pickError ? "import-file-hint import-file-error" : "import-file-hint"
              }
              aria-invalid={pickError ? true : undefined}
              onChange={(e) => void choose(e.target.files?.[0])}
              className="block w-full max-w-md cursor-pointer text-sm file:mr-3 file:h-9 file:cursor-pointer file:rounded-lg file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium"
            />
            {pickError ? (
              <p
                id="import-file-error"
                role="alert"
                className="text-sm font-medium text-destructive"
              >
                <span className="sr-only">Error: </span>
                {pickError}
              </p>
            ) : null}
            {file ? (
              <p className="flex items-center gap-2 text-sm" role="status">
                <FileSpreadsheet aria-hidden="true" className="size-4" />
                <span>
                  <span className="font-medium">{file.name}</span> ({size(file.size)}) is ready to
                  check.
                </span>
              </p>
            ) : null}
          </div>
          <div className="flex max-w-prose flex-col gap-2 text-sm text-muted-foreground">
            <p>
              The first row names the columns.{" "}
              <strong className="text-foreground">display_name</strong> (or <em>name</em>) is
              required. These are also understood: type, company_name, email, phone, website,
              status, source, tags, notes. Other columns are listed and ignored.
            </p>
            <p>Nothing is added yet: you review the file first.</p>
          </div>
          <div>
            <Button
              type="button"
              onClick={() => void runPreview()}
              disabled={!file || busy !== null}
            >
              {busy === "preview" ? "Checking the file…" : "Check the file"}
            </Button>
          </div>
        </section>
      ) : null}

      {step === "review" && preview && plan ? (
        <section aria-labelledby="step-review" className="flex flex-col gap-6">
          <h2
            id="step-review"
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            Review {file?.name ?? "your file"}
          </h2>

          {preview.status === "committed" ? (
            <p role="note" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
              This exact file was already imported into this workspace in the last hour. Importing
              again adds nothing; it shows what happened.
            </p>
          ) : null}

          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Rows in the file" value={preview.counts.total} />
            <Stat label="Will be imported" value={plan.willImport} strong />
            <Stat label="Skipped: errors" value={plan.invalid} />
            <Stat
              label={`Skipped: repeated email${plan.duplicatesApproximate ? " (at least)" : ""}`}
              value={plan.duplicateRows}
            />
          </dl>

          {preview.demo?.wouldExceed ? (
            <p
              role="note"
              className="flex gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                A demo workspace holds at most 50 customers and has room for{" "}
                {plural(preview.demo.remaining, "more")}. The other{" "}
                {plural(plan.overDemoCap, "row")} would not be imported.
              </span>
            </p>
          ) : null}

          <div className="flex flex-col gap-1 text-sm">
            <h3 className="font-semibold">Columns</h3>
            <p>
              Understood:{" "}
              {preview.columns.mapped.map((m, i) => (
                <span key={m.header}>
                  {i > 0 ? ", " : ""}
                  <span className="font-medium">{m.header}</span> → {label(m.field)}
                </span>
              ))}
              .
            </p>
            {preview.columns.unknown.length > 0 ? (
              <p className="text-muted-foreground">
                Ignored (not customer fields): {preview.columns.unknown.join(", ")}.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="font-semibold">
              First {preview.rows.length} {preview.rows.length === 1 ? "row" : "rows"}
            </h3>
            <div
              role="region"
              aria-label="Preview of the first rows"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
              tabIndex={0}
              className="overflow-x-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <table className="w-full min-w-[40rem] text-left text-sm">
                <caption className="sr-only">
                  The first rows of the file and whether each can be imported
                </caption>
                <thead className="border-b border-border bg-muted/50">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Row
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Check
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Name
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Email
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Company
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} className="border-b border-border last:border-0 align-top">
                      <td className="px-3 py-2 tabular-nums">{r.row}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {r.valid ? (
                          <span className="inline-flex items-center gap-1.5">
                            <CircleCheck
                              aria-hidden="true"
                              className="size-4 text-muted-foreground"
                            />
                            OK
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <CircleX aria-hidden="true" className="size-4 text-muted-foreground" />
                            Has errors
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.values.displayName ?? (
                          <span className="text-muted-foreground">Missing</span>
                        )}
                      </td>
                      <td className="px-3 py-2">{r.values.email ?? "-"}</td>
                      <td className="px-3 py-2">{r.values.companyName ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {preview.errors.length > 0 ? (
            <IssueTable
              title={`Errors (${plural(preview.counts.invalid, "row")} skipped)`}
              caption="Rows that cannot be imported and why"
              issues={preview.errors}
              truncated={preview.errorsTruncated}
            />
          ) : null}
          {preview.warnings.length > 0 ? (
            <IssueTable
              title="Repeated email addresses (these rows are skipped)"
              caption="Rows whose email address is already in the workspace or earlier in the file"
              issues={preview.warnings}
              truncated={preview.warningsTruncated}
            />
          ) : null}

          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <p aria-live="polite" className="text-sm">
              {preview.status === "committed" ? (
                "Nothing will be added again."
              ) : (
                <>
                  <strong>{plural(plan.willImport, "customer")}</strong> will be imported.{" "}
                  {plan.invalid + plan.duplicateRows + plan.overDemoCap > 0
                    ? `${plural(plan.invalid + plan.duplicateRows + plan.overDemoCap, "row")} will be skipped: ${plan.invalid} with errors, ${plan.duplicateRows} with a repeated email${plan.overDemoCap > 0 ? `, ${plan.overDemoCap} over the demo limit` : ""}.`
                    : "No rows will be skipped."}
                </>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={() => void runImport()}
                disabled={
                  busy !== null || (preview.status !== "committed" && plan.willImport === 0)
                }
              >
                {busy === "import"
                  ? "Importing…"
                  : preview.status === "committed"
                    ? "Show what happened"
                    : plan.willImport === 0
                      ? "Nothing to import"
                      : `Import ${plural(plan.willImport, "customer")}`}
              </Button>
              <Button type="button" variant="outline" onClick={startOver} disabled={busy !== null}>
                Choose a different file
              </Button>
              {plan.invalid + plan.duplicateRows > 0 ? (
                <Button type="button" variant="ghost" onClick={() => void downloadReport()}>
                  <Download aria-hidden="true" />
                  Download error report
                </Button>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {step === "result" && result ? (
        <section aria-labelledby="step-result" className="flex flex-col gap-5">
          <h2
            id="step-result"
            ref={heading}
            tabIndex={-1}
            className="text-lg font-semibold outline-none"
          >
            {result.status === "failed"
              ? "Nothing was imported"
              : result.replayed
                ? "This file was already imported"
                : `${plural(result.imported, "customer")} imported`}
          </h2>
          {result.replayed ? (
            <p role="note" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
              Nothing was added this time. This is what the earlier import did.
            </p>
          ) : null}
          {result.demoCapReached ? (
            <p
              role="note"
              className="flex gap-2 rounded-lg border border-border bg-muted/50 p-3 text-sm"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                The demo workspace reached its limit of 50 customers, so{" "}
                {plural(result.notImportedDemoCap, "row")} could not be added. Create an account to
                import without this limit.
              </span>
            </p>
          ) : null}
          {result.failedRows > 0 ? (
            <p
              role="alert"
              className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
            >
              <CircleX aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {plural(result.failedRows, "row")} could not be saved because saving a group of rows
                failed. The report lists their row numbers: put those rows in a new file and import
                that.
              </span>
            </p>
          ) : null}
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Imported" value={result.imported} strong />
            <Stat label="Skipped: repeated email" value={result.skippedDuplicates} />
            <Stat label="Skipped: errors" value={result.rejected} />
            <Stat
              label="Could not be saved"
              value={result.failedRows + result.notImportedDemoCap}
            />
          </dl>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/app/customers?sort=created_at&order=desc" className={buttonVariants()}>
              View imported customers
            </Link>
            <Button type="button" variant="outline" onClick={startOver}>
              Import another file
            </Button>
            {result.rejected + result.skippedDuplicates + result.failedRows > 0 ? (
              <Button type="button" variant="ghost" onClick={() => void downloadReport()}>
                <Download aria-hidden="true" />
                Download error report
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      {isDemo && step === "upload" ? (
        <p className="text-xs text-muted-foreground">
          You are in a demo: it holds up to 50 customers, and everything is fictional sample data.
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label: text, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <dt className="text-sm text-muted-foreground">{text}</dt>
      <dd className={cn("text-2xl tabular-nums", strong ? "font-semibold" : "font-medium")}>
        {value.toLocaleString("en-US")}
      </dd>
    </div>
  );
}

function IssueTable({
  title,
  caption,
  issues,
  truncated,
}: {
  title: string;
  caption: string;
  issues: Array<{ row: number; field: string | null; message: string }>;
  truncated: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      <div
        role="region"
        aria-label={caption}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-lg border border-border outline-none focus-visible:ring-3 focus-visible:ring-ring"
      >
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 border-b border-border bg-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Row
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Field
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Problem
              </th>
            </tr>
          </thead>
          <tbody>
            {issues.map((e, i) => (
              <tr key={`${e.row}-${e.field}-${i}`} className="border-b border-border last:border-0">
                <td className="px-3 py-2 tabular-nums">{e.row}</td>
                <td className="px-3 py-2">{label(e.field)}</td>
                <td className="px-3 py-2">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="text-sm text-muted-foreground">
          More problems exist than are listed here. The error report has what the import keeps.
        </p>
      ) : null}
    </div>
  );
}
