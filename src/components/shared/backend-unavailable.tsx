"use client";

import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { StatePanel } from "./state-panel";

type Props = {
  /** What the visitor was trying to do: "open the demo", "load your workspace". */
  action?: string;
  /** Public repository link, shown when configured. */
  repoUrl?: string;
  className?: string;
};

/**
 * The backend (database and sign-in) is paused or not answering. Says so plainly, never shows partial or placeholder
 * data as if it were real, and keeps the static parts of the site one click away: the project overview and the code.
 * Free-tier backends pause when idle; trying again after a minute usually brings one back.
 */
export function BackendUnavailable({ action = "load this page", repoUrl, className }: Props) {
  return (
    <StatePanel
      className={className}
      title="The live backend is not answering"
      description={
        <>
          <p>
            We could not {action} because the database is paused or unreachable. Nothing was lost
            and nothing was created. This usually clears within a minute: try again.
          </p>
          <p className="mt-2">
            Meanwhile, the project overview and the source code are still available.
          </p>
        </>
      }
      actions={
        <>
          <Button type="button" onClick={() => window.location.reload()}>
            Try again
          </Button>
          <Link href="/#technical-overview" className={cn(buttonVariants({ variant: "outline" }))}>
            Read the technical overview
          </Link>
          <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
            Back to home
          </Link>
          {repoUrl ? (
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              View the code on GitHub
            </a>
          ) : null}
        </>
      }
    />
  );
}
