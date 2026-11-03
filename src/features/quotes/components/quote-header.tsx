import Link from "next/link";
import type { QuoteDetailDto } from "../schema";
import { QuoteStatus } from "./quote-status";

/** The quote's identity: title, number, status (icon and word) and customer, with a link back to the list. */
export function QuoteHeader({
  quote,
}: {
  quote: Pick<QuoteDetailDto, "title" | "quoteNumber" | "status" | "customerId" | "customerName">;
}) {
  return (
    <header className="flex flex-col gap-1">
      <p className="text-sm">
        <Link
          href="/app/quotes"
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          All quotes
        </Link>
      </p>
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
        </span>
      </p>
    </header>
  );
}
