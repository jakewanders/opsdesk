"use client";

import { AlertTriangle, Check } from "lucide-react";
import { formatTaxRate } from "@/lib/domain/quotes";
import { formatUsd } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import type { Mismatch, Preview } from "../form-values";

type Props = {
  preview: Preview;
  /** The tax rate in basis points, for the label. */
  taxRateBps: number | null;
  /** What the server saved, once there is a save: it replaces the preview as the truth. */
  saved?: {
    subtotalCents: number;
    discountCents: number;
    taxCents: number;
    totalCents: number;
    taxRateBps: number;
  } | null;
  mismatches: Mismatch[];
  className?: string;
};

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-6",
        strong && "border-t border-border pt-3",
      )}
    >
      <dt className={cn("text-sm", strong ? "font-semibold" : "text-muted-foreground")}>{label}</dt>
      <dd className={cn("text-right tabular-nums", strong ? "text-xl font-semibold" : "text-sm")}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The totals panel. While editing it shows a PREVIEW calculated in the browser with the shared calculation module and says so;
 * after a save the server's own totals (the saved ones) are shown, and if the two ever differ that is surfaced as a warning
 * rather than hidden. Invalid or incomplete input shows no numbers at all, never wrong ones.
 */
export function QuoteSummary({ preview, taxRateBps, saved, mismatches, className }: Props) {
  const t = preview.ok ? preview.totals : null;
  return (
    <section
      aria-labelledby="quote-summary-title"
      className={cn("rounded-lg border border-border bg-muted/40 p-4", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="quote-summary-title" className="text-sm font-semibold">
          Totals
        </h2>
        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium">
          {saved && mismatches.length === 0 ? "Saved" : "Preview"}
        </span>
      </div>
      {t ? (
        <dl className="mt-3 flex flex-col gap-2" aria-live="polite" aria-atomic="true">
          <Row label="Subtotal" value={formatUsd(t.subtotalCents)} />
          {t.discountCents > 0 ? (
            <Row label="Discount" value={`-${formatUsd(t.discountCents)}`} />
          ) : null}
          <Row
            label={`Tax${taxRateBps ? ` (${formatTaxRate(taxRateBps)})` : ""}`}
            value={formatUsd(t.taxCents)}
          />
          <Row label="Total" value={formatUsd(t.totalCents)} strong />
        </dl>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">
          Fix the highlighted fields to see the totals.
        </p>
      )}
      {saved && mismatches.length === 0 ? (
        <p className="mt-3 flex items-start gap-2 text-sm text-muted-foreground">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          These are the totals the server calculated and saved.
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Calculated here as you type. The totals the server saves are the ones that count.
        </p>
      )}
      {mismatches.length > 0 && saved ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-destructive/40 bg-destructive-subtle p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-semibold">
            <AlertTriangle aria-hidden="true" className="size-4" />
            The saved totals differ from the preview
          </p>
          <ul className="mt-1 list-disc pl-5">
            {mismatches.map((m) => (
              <li key={m.field}>
                {m.field}: preview {formatUsd(m.preview)}, saved {formatUsd(m.saved)}
              </li>
            ))}
          </ul>
          <p className="mt-1">
            The saved amounts are the real ones. Check the line items and report this if it
            persists.
          </p>
          <p className="mt-1 font-medium tabular-nums">
            Saved total: {formatUsd(saved.totalCents)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
