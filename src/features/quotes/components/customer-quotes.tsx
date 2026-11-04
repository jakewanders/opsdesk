"use client";

import { FileText, Plus } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { buttonVariants } from "@/components/ui/button";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { formatUsd } from "@/lib/money/format";
import type { QuoteDto } from "../schema";
import { QuoteStatus } from "./quote-status";

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const SHOWN = 10;

/** The Quotes tab of a customer: their most recent quotes, a link to the full list filtered to them, and "New quote" for writers. */
export function CustomerQuotes({
  customerId,
  canWrite,
}: {
  customerId: string;
  canWrite: boolean;
}) {
  const query = useApiQuery<QuoteDto[]>(["quotes", { customerId, tab: true }], "/quotes", {
    query: { customerId, limit: SHOWN, sort: "updated_at", order: "desc" },
  });
  const newHref = `/app/quotes/new?customerId=${customerId}`;
  const total = Number(query.data?.meta.total ?? 0);

  if (query.isPending) return <TableSkeleton label="Loading quotes" columns={4} rows={3} />;
  if (query.isError)
    return (
      <ErrorAlert
        title="Quotes could not be loaded"
        message={
          isClientApiError(query.error) ? query.error.message : "Something went wrong. Try again."
        }
        requestId={isClientApiError(query.error) ? query.error.requestId : undefined}
        onRetry={() => void query.refetch()}
      />
    );
  const items = query.data?.data ?? [];
  if (items.length === 0)
    return (
      <EmptyState
        icon={<FileText />}
        headingLevel={3}
        title="No quotes for this customer yet"
        description={
          canWrite
            ? "Start a quote for this customer: add line items, then send it when it is ready."
            : "No quotes have been created for this customer."
        }
        action={
          canWrite ? (
            <Link href={newHref} className={buttonVariants()}>
              <Plus aria-hidden="true" />
              New quote
            </Link>
          ) : undefined
        }
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <Link
          href={`/app/quotes?customerId=${customerId}`}
          className="font-medium underline underline-offset-4"
        >
          {total > items.length ? `See all ${total} quotes` : "Open in the quote list"}
        </Link>
        {canWrite ? (
          <Link href={newHref} className={buttonVariants({ size: "sm" })}>
            <Plus aria-hidden="true" />
            New quote
          </Link>
        ) : null}
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {items.map((q) => (
          <li
            key={q.id}
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm"
          >
            <div className="flex min-w-0 flex-col">
              <Link
                href={`/app/quotes/${q.id}`}
                className="font-medium underline-offset-4 hover:underline"
              >
                {q.quoteNumber}: {q.title}
              </Link>
              <span className="text-muted-foreground">
                Issued{" "}
                <time dateTime={q.issueDate}>
                  {DAY.format(new Date(`${q.issueDate}T00:00:00Z`))}
                </time>
              </span>
            </div>
            <div className="flex items-center gap-4">
              <QuoteStatus status={q.status} id={q.id} />
              <span className="tabular-nums font-medium">{formatUsd(q.totalCents)}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
