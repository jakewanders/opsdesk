"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { formatTaxRate } from "@/lib/domain/quotes";
import { formatUsd } from "@/lib/money/format";
import type { QuoteDetailDto } from "../schema";
import { QuoteSummary } from "./quote-summary";

const STATUS_LABEL = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
} as const;
const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

/**
 * A quote whose financial fields cannot change: any quote that has been sent (or later), and a draft seen by someone who may not
 * edit it. Nothing here is an input. A writer is offered "Create revision" instead, which starts a new draft that points back at
 * this quote and leaves it exactly as it is.
 */
export function QuoteReadOnly({ quote, canWrite }: { quote: QuoteDetailDto; canWrite: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const revise = useApiMutation<QuoteDetailDto, void>({
    mutationFn: (_v, { call }) =>
      call<QuoteDetailDto>(`/quotes/${quote.id}/revise`, { method: "POST" }),
    invalidate: [["quotes"], ["quote"]],
  });
  const canRevise = canWrite && quote.status !== "draft";
  const openRevision = quote.revisions.find((r) => r.status === "draft");

  async function createRevision() {
    setError(null);
    try {
      const res = await revise.mutateAsync();
      notify.success(
        "Revision created",
        `${res.data.quoteNumber} is a new draft of ${quote.quoteNumber}.`,
      );
      router.push(`/app/quotes/${res.data.id}`);
    } catch (e) {
      setError(isClientApiError(e) ? e.message : "The revision could not be created. Try again.");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-6">
        {error ? <ErrorAlert title="Could not create the revision" message={error} /> : null}
        {quote.status === "draft" ? (
          <p className="text-sm text-muted-foreground">
            You can view this draft but not edit it. Ask an owner, admin or member if it needs
            changes.
          </p>
        ) : (
          <p role="note" className="rounded-lg border border-border bg-muted/50 p-3 text-sm">
            This quote is {STATUS_LABEL[quote.status].toLowerCase()}, so its amounts and lines can
            no longer change.
            {canRevise
              ? " To correct it, create a revision: a new draft that starts from this quote."
              : ""}
          </p>
        )}
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Customer</dt>
            <dd className="font-medium">{quote.customerName ?? "Unknown customer"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Status</dt>
            <dd className="font-medium">{STATUS_LABEL[quote.status]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Issue date</dt>
            <dd>{day(quote.issueDate)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Valid until</dt>
            <dd>{quote.validUntil ? day(quote.validUntil) : "No end date"}</dd>
          </div>
          {quote.revises ? (
            <div>
              <dt className="text-muted-foreground">Revises</dt>
              <dd>
                <Link
                  className="underline underline-offset-4"
                  href={`/app/quotes/${quote.revises.id}`}
                >
                  {quote.revises.quoteNumber}
                </Link>
              </dd>
            </div>
          ) : null}
          {quote.notes ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-wrap">{quote.notes}</dd>
            </div>
          ) : null}
        </dl>
        <section aria-labelledby="quote-lines-title" className="flex flex-col gap-3">
          <h2 id="quote-lines-title" className="text-lg font-semibold">
            Line items
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Line items of {quote.quoteNumber}</caption>
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Description
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Quantity
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Unit price
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {quote.items.map((i) => (
                  <tr key={i.id}>
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {i.description}
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {i.quantity.toLocaleString("en-US")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatUsd(i.unitPriceCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatUsd(i.lineTotalCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        {canRevise ? (
          <div className="flex flex-wrap items-center gap-3">
            {openRevision ? (
              <Link
                className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
                href={`/app/quotes/${openRevision.id}`}
              >
                Open draft revision {openRevision.quoteNumber}
              </Link>
            ) : (
              <Button
                type="button"
                onClick={() => void createRevision()}
                disabled={revise.isPending}
              >
                {revise.isPending ? "Creating..." : "Create revision"}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <QuoteSummary
          preview={{
            ok: true,
            totals: {
              lineTotalsCents: quote.items.map((i) => i.lineTotalCents),
              subtotalCents: quote.subtotalCents,
              discountCents: quote.discountCents,
              taxableCents: quote.subtotalCents - quote.discountCents,
              taxCents: quote.taxCents,
              totalCents: quote.totalCents,
            },
          }}
          taxRateBps={quote.taxRateBps}
          saved={{
            subtotalCents: quote.subtotalCents,
            discountCents: quote.discountCents,
            taxCents: quote.taxCents,
            totalCents: quote.totalCents,
            taxRateBps: quote.taxRateBps,
          }}
          mismatches={[]}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Tax rate {formatTaxRate(quote.taxRateBps)}. These are the totals the server saved.
        </p>
      </aside>
    </div>
  );
}
