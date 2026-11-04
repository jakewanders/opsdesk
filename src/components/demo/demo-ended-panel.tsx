"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { RestartState } from "@/lib/demo/actions";

type Action = (state: RestartState) => Promise<RestartState>;

/**
 * "Your demo has ended": says what happened and offers one way forward. The button restarts the demo with the
 * guest's existing session; the old data is gone, and nothing is converted into a real workspace.
 */
export function DemoEndedPanel({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <section aria-labelledby="demo-ended-title" className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 id="demo-ended-title" className="text-2xl font-semibold tracking-tight">
          Your demo has ended
        </h1>
        <p className="text-muted-foreground">
          Demo workspaces last 24 hours, then the fictional data is deleted. Start a new demo to
          explore again with a fresh set of sample data.
        </p>
      </header>
      {state.error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
        >
          {state.error}
        </p>
      ) : null}
      <form action={formAction}>
        {pending ? (
          <span role="status" className="sr-only">
            Starting…
          </span>
        ) : null}
        <Button type="submit" pending={pending} className="h-10">
          Start a new demo
        </Button>
      </form>
      <p className="text-sm text-muted-foreground">
        Want to keep your work? Demo data is not kept. Create an account and start from your own
        data.
      </p>
    </section>
  );
}
