"use client";

import { Clock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { announceBand, bandLabel, formatRemaining } from "@/lib/demo/time-remaining";

type DemoCountdownProps = {
  /** The database `expires_at` (ISO). The countdown never trusts the browser clock for "now". */
  expiresAt: string;
  /** The server's clock (ISO) at render time; elapsed time in this tab is added from a monotonic clock. */
  serverNow: string;
  /** Guest actions shown at the end of the banner (Reset Demo). */
  actions?: ReactNode;
};

/**
 * Shows how long the demo has left. "Now" is the server's time at render plus the time this tab has been open
 * (a monotonic clock), so a wrong or changed device clock cannot extend or shorten the demo. The visible text
 * updates every 5 s; a separate polite live region speaks only at 60, 10, 5 and 1 minute and at expiry. At zero
 * the page refreshes, and the proxy sends an expired guest to the "Your demo has ended" page.
 */
export function DemoCountdown({ expiresAt, serverNow, actions }: DemoCountdownProps) {
  const router = useRouter();
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const opened = performance.now();
    const id = window.setInterval(() => setElapsedMs(performance.now() - opened), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const nowMs = new Date(serverNow).getTime() + elapsedMs;
  const remaining = Math.max(0, Math.floor((new Date(expiresAt).getTime() - nowMs) / 1000));
  const band = announceBand(remaining);

  useEffect(() => {
    if (remaining === 0 && elapsedMs > 0) router.refresh();
  }, [remaining, elapsedMs, router]);

  const ended = remaining === 0;
  const nearEnd = !ended && remaining < 600;

  return (
    <div
      role="note"
      aria-label="Demo workspace"
      data-state={ended ? "ended" : nearEnd ? "near-end" : "active"}
      className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-sm text-foreground"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="flex items-center gap-2">
          <Clock aria-hidden="true" className="size-4 shrink-0" />
          <strong className="font-semibold">
            Demo workspace • fictional data • resets automatically
          </strong>
        </p>
        <p className={nearEnd ? "font-semibold" : undefined}>
          {ended ? (
            "This demo has ended."
          ) : (
            <>
              {nearEnd ? "Less than 10 minutes left: about " : "About "}
              <span data-testid="demo-remaining">{formatRemaining(remaining)}</span> left.
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {actions}
          <Link
            href="/signup"
            className="rounded-md px-1 font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring"
          >
            Create an account
          </Link>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Data is fictional and is deleted when the demo ends. A new account starts empty: demo data
        is not carried over.
      </p>
      <span className="sr-only" role="status" aria-live="polite">
        {band === null ? "" : bandLabel(band)}
      </span>
    </div>
  );
}
