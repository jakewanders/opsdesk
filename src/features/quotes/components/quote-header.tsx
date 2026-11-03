import Link from "next/link";
import { ArchivedBadge } from "@/components/shared/archived-badge";
import { Breadcrumbs } from "@/components/shared/breadcrumbs";
import { ListLink } from "@/components/shared/list-crumb";
import type { QuoteDetailDto } from "../schema";
import { QuoteStatus } from "./quote-status";

type HeaderQuote = Pick<
  QuoteDetailDto,
  "title" | "quoteNumber" | "status" | "customerId" | "customerName"
> &
  Partial<
    Pick<
      QuoteDetailDto,
      "customerArchived" | "opportunityId" | "opportunityTitle" | "opportunityArchived"
    >
  >;

/**
 * The quote's identity: breadcrumbs back to the list (with the filters it had), title, number, status (icon and word), and the
 * customer and deal it belongs to as links, archived ones marked.
 */
export function QuoteHeader({ quote }: { quote: HeaderQuote }) {
  return (
    <header className="flex flex-col gap-2">
      <Breadcrumbs
        items={[
          { label: "Quotes", node: <ListLink list="quotes">Quotes</ListLink> },
          { label: quote.quoteNumber },
        ]}
      />
      <h1 className="text-2xl font-semibold tracking-tight">{quote.title}</h1>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{quote.quoteNumber}</span>
        <QuoteStatus status={quote.status} />
        <span>
          for{" "}
          <Link
            href={`/app/customers/${quote.customerId}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {quote.customerName ?? "Unknown customer"}
          </Link>
          {quote.customerArchived ? <ArchivedBadge /> : null}
        </span>
        {quote.opportunityId ? (
          <span>
            deal{" "}
            <Link
              href={`/app/opportunities/${quote.opportunityId}`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {quote.opportunityTitle ?? "Opportunity"}
            </Link>
            {quote.opportunityArchived ? <ArchivedBadge /> : null}
          </span>
        ) : null}
      </p>
    </header>
  );
}
