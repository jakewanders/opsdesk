"use client";

import { Button } from "@/components/ui/button";
import { StatePanel } from "./state-panel";

type ErrorPanelProps = {
  error: Error & { digest?: string };
  reset: () => void;
};

/** Error boundary body: says what happened, gives a reference for support, offers a retry. */
export function ErrorPanel({ error, reset }: ErrorPanelProps) {
  return (
    <StatePanel
      title="Something went wrong"
      description={
        <>
          <p>
            The page could not be loaded. Try again, and if it keeps failing, report the reference
            below.
          </p>
          {error.digest ? (
            <p className="mt-2 font-mono text-sm">Reference: {error.digest}</p>
          ) : null}
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
