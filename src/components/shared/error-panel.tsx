"use client";

import { Button } from "@/components/ui/button";
import { isStaleActionError } from "@/lib/auth/stale-action";
import { StatePanel } from "./state-panel";

type ErrorPanelProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Error boundary body: says what happened, gives a reference for support, offers a retry. An error thrown in the browser has no
 * server digest, so it shows the error's own name and message instead (so there is always something to report). A page that was
 * left open across a deploy gets its own words and a reload button, because retrying the same stale page cannot work.
 */
export function ErrorPanel({ error, reset }: ErrorPanelProps) {
  if (isStaleActionError(error)) {
    return (
      <StatePanel
        title="This page is out of date"
        description={
          <p>
            OpsDesk was updated while this page was open. Reload to get the latest version, then try
            again. Nothing was saved.
          </p>
        }
        actions={
          <Button type="button" onClick={() => window.location.reload()}>
            Reload page
          </Button>
        }
      />
    );
  }
  const detail = error.digest
    ? `Reference: ${error.digest}`
    : `Details: ${[error.name, error.message].filter(Boolean).join(": ").slice(0, 200)}`;
  return (
    <StatePanel
      title="Something went wrong"
      description={
        <>
          <p>
            The page could not be loaded. Try again, and if it keeps failing, report the reference
            below.
          </p>
          <p className="mt-2 font-mono text-sm">{detail}</p>
        </>
      }
      actions={
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
