"use client";

import { Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { TurnstileField } from "@/components/auth/turnstile-field";
import { Button, buttonVariants } from "@/components/ui/button";
import { newIdempotencyKey } from "@/lib/api-client/idempotency";
import { classifyDemoFailure, type DemoFailure } from "@/lib/demo/failure";
import { cn } from "@/lib/utils";

/** Everything the flow touches outside React, so it can be tested without a browser or a database. */
export type DemoEntryDeps = {
  /** True when this browser already holds a guest session (a retry after sign-in worked but bootstrap did not). */
  hasSession: () => Promise<boolean>;
  signIn: (captchaToken: string) => Promise<DemoStepResult>;
  bootstrap: (idempotencyKey: string) => Promise<DemoStepResult>;
  navigate: (path: string) => void;
};
export type DemoStepResult =
  | { ok: true }
  | { ok: false; status?: number; code?: string; network?: boolean; requestId?: string };

type Phase = "checking" | "preparing" | "error";

type Props = {
  siteKey: string | undefined;
  /** Public repository link, shown with the failure options when configured. */
  repoUrl?: string;
  deps: DemoEntryDeps;
};

/**
 * `/demo` for a visitor with no session: an invisible security check, an anonymous sign-in, the bootstrap request,
 * then the app. It starts by itself as soon as the check passes, so the whole path from the landing page is one
 * click. A failure is named, retryable, and never shown as success; nothing is created unless every step passed.
 */
export function DemoEntry({ siteKey, repoUrl, deps }: Props) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [failure, setFailure] = useState<DemoFailure | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const token = useRef("");
  const phaseRef = useRef<Phase>("checking");
  const key = useRef<string | null>(null);

  function go(next: Phase) {
    phaseRef.current = next;
    setPhase(next);
  }

  function fail(f: DemoFailure) {
    // Client-side only: the browser console is where a developer looks first. It carries the failure kind, the Auth or API code and the
    // request id, nothing about the visitor, so it bypasses no server-side redaction.
    // eslint-disable-next-line no-console
    console.warn("[opsdesk] demo start failed", {
      kind: f.kind,
      code: f.code,
      requestId: f.requestId,
    });
    setFailure(f);
    go("error");
    token.current = "";
    setResetKey((k) => k + 1); // a token works once: ask the widget for a new one
  }

  async function start() {
    if (phaseRef.current === "preparing") return; // double clicks and repeat tokens are ignored
    go("preparing");
    setFailure(null);
    // One key per intent: a failed attempt keeps it, so the retry replays instead of repeating the work.
    key.current ??= newIdempotencyKey();
    const existing = await deps.hasSession();
    if (!existing) {
      const signedIn = await deps.signIn(token.current);
      if (!signedIn.ok) return fail(classifyDemoFailure({ step: "signin", ...signedIn }));
    }
    const boot = await deps.bootstrap(key.current);
    if (!boot.ok) return fail(classifyDemoFailure({ step: "bootstrap", ...boot }));
    key.current = null;
    deps.navigate("/app");
  }

  function onToken(value: string) {
    token.current = value;
    if (value && phaseRef.current === "checking") void start();
  }

  function onWidgetError() {
    if (phaseRef.current !== "preparing") {
      fail(classifyDemoFailure({ step: "signin", code: "captcha_failed" }));
    }
  }

  function retry() {
    if (phaseRef.current === "preparing") return;
    if (token.current) {
      void start();
    } else {
      go("checking"); // the fresh token from the reset widget starts it
    }
  }

  return (
    <section aria-labelledby="demo-entry-title" className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 id="demo-entry-title" className="text-2xl font-semibold tracking-tight">
          {phase === "error" && failure ? failure.title : "Opening your demo"}
        </h1>
        <p className="text-muted-foreground">
          A private workspace filled with fictional data. No sign-up, nothing to install.
        </p>
      </header>

      <div role="status" aria-live="polite" className={phase === "error" ? undefined : "min-h-6"}>
        {phase === "checking" ? (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Running a quick security check. If a box appears, complete it to continue.
          </p>
        ) : null}
        {phase === "preparing" ? (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Preparing your demo workspace
          </p>
        ) : null}
      </div>

      <TurnstileField
        siteKey={siteKey}
        resetKey={resetKey}
        appearance="interaction-only"
        onToken={onToken}
        onError={onWidgetError}
      />

      {phase === "error" && failure ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
        >
          <p className="flex gap-2">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{failure.message}</span>
          </p>
          {failure.requestId ? (
            <p className="text-xs text-muted-foreground">Reference: {failure.requestId}</p>
          ) : failure.code ? (
            <p className="text-xs text-muted-foreground">Error code: {failure.code}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {failure.retryable ? (
              <Button type="button" onClick={retry} className="h-10">
                Try again
              </Button>
            ) : failure.kind === "member" ? (
              <Link href="/app" className={cn(buttonVariants(), "h-10")}>
                Open my workspace
              </Link>
            ) : null}
            <Link href="/#technical-overview" className="underline underline-offset-4">
              Read the technical overview
            </Link>
            <Link href="/" className="underline underline-offset-4">
              Back to home
            </Link>
            {repoUrl ? (
              <a
                href={repoUrl}
                className="underline underline-offset-4"
                target="_blank"
                rel="noreferrer noopener"
              >
                View the code on GitHub
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
