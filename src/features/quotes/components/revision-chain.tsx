import { GitBranch } from "lucide-react";
import Link from "next/link";
import type { QuoteDetailDto } from "../schema";
import { QUOTE_STATUS_LABELS } from "./quote-status";

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * The revision chain one step each way: the quote this one revises (the earlier version) and the revisions made from it (the later
 * ones), each a link with its status. Renders nothing for a quote that was never revised and revises nothing.
 */
export function RevisionChain({ quote }: { quote: Pick<QuoteDetailDto, "revises" | "revisions"> }) {
  if (!quote.revises && quote.revisions.length === 0) return null;
  return (
    <section
      aria-labelledby="revision-chain-title"
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    >
      <h2 id="revision-chain-title" className="flex items-center gap-2 font-semibold">
        <GitBranch aria-hidden="true" className="size-4" />
        Revision history
      </h2>
      <ul className="flex flex-col gap-1.5">
        {quote.revises ? (
          <li>
            <span className="text-muted-foreground">Revises (earlier version): </span>
            <Link
              href={`/app/quotes/${quote.revises.id}`}
              className="font-medium underline underline-offset-4"
            >
              {quote.revises.quoteNumber}
            </Link>{" "}
            <span className="text-muted-foreground">
              ({QUOTE_STATUS_LABELS[quote.revises.status]})
            </span>
          </li>
        ) : null}
        {quote.revisions.map((r) => (
          <li key={r.id}>
            <span className="text-muted-foreground">Revised by (later version): </span>
            <Link href={`/app/quotes/${r.id}`} className="font-medium underline underline-offset-4">
              {r.quoteNumber}
            </Link>{" "}
            <span className="text-muted-foreground">
              ({QUOTE_STATUS_LABELS[r.status]}, created{" "}
              <time dateTime={r.createdAt}>{DAY.format(new Date(r.createdAt))}</time>)
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
