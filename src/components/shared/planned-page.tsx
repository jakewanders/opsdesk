import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatePanel } from "./state-panel";

type PlannedPageProps = {
  title: string;
  /** What this page will do, in user terms. */
  summary: string;
  /** Delivery milestone from the PRD, for example "M2". */
  milestone: string;
  /** Where to send the visitor in the meantime. */
  backHref?: string;
  backLabel?: string;
};

/**
 * Honest holding page for a route that exists in the PRD route map but whose feature is built
 * in a later milestone. The route resolves (no broken links); the page says plainly that the
 * feature is not available yet and never shows fake data.
 */
export function PlannedPage({
  title,
  summary,
  milestone,
  backHref = "/app",
  backLabel = "Back to dashboard",
}: PlannedPageProps) {
  return (
    <StatePanel
      title={title}
      description={
        <>
          <p>{summary}</p>
          <p className="mt-2">Not available yet. This page is planned for milestone {milestone}.</p>
        </>
      }
      actions={
        <Link href={backHref} className={cn(buttonVariants({ variant: "outline" }))}>
          {backLabel}
        </Link>
      }
    />
  );
}
