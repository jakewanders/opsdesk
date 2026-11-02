"use client";

import { Check, MailWarning, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isClientApiError, apiFetch } from "@/lib/api-client/api-fetch";
import { logoutAction } from "@/lib/auth/actions";
import { selectWorkspaceAction } from "@/lib/org/actions";
import { type Outcome, outcomeFor } from "../invite-outcomes";
import { clearStashedToken, stashToken, takeStashedToken, tokenFromHash } from "../invite-token";
import { ROLE_HELP, ROLE_LABELS, type Role } from "../member-rules";
import type { InvitationPreview } from "../service";

export type Viewer =
  { kind: "signed-out" } | { kind: "guest" } | { kind: "member"; email: string | null };

type Phase =
  | { name: "reading" }
  | { name: "missing" }
  | { name: "signin" }
  | { name: "ready"; token: string; preview: InvitationPreview }
  | { name: "checking"; token: string }
  | { name: "refused"; token: string | null; outcome: Outcome; code: string | undefined }
  | { name: "joining" };

const NEXT = "?next=%2Finvite";

/**
 * The page an invitation link opens. The token comes from the URL fragment, is removed from the address bar at once, and
 * lives in memory; only the trip to sign in or sign up parks it in this tab's sessionStorage. A signed-in person sees the
 * workspace and role on offer before choosing to join; every refusal says what happened and what to do next. Everything
 * here is presentation: the database decides who may join (SIT-202).
 */
export function AcceptInvite({ viewer }: { viewer: Viewer }) {
  const [phase, setPhase] = useState<Phase>({ name: "reading" });

  const check = useCallback(async (token: string) => {
    setPhase({ name: "checking", token });
    try {
      const res = await apiFetch<InvitationPreview>("/invitations/preview", {
        method: "POST",
        json: { token },
      });
      setPhase({ name: "ready", token, preview: res.data });
    } catch (error) {
      const code = isClientApiError(error) ? error.code : undefined;
      setPhase({ name: "refused", token, outcome: outcomeFor(code), code });
    }
  }, []);

  const start = useCallback(async () => {
    // Read once, then take the token out of the address bar and the history entry.
    const fromHash = tokenFromHash(window.location.hash);
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    const token = fromHash ?? takeStashedToken();
    if (!token) {
      setPhase({ name: "missing" });
    } else if (viewer.kind === "member") {
      await check(token);
    } else {
      stashToken(token); // waits here while the person signs in or creates an account
      setPhase({ name: "signin" });
    }
  }, [viewer.kind, check]);

  useEffect(() => {
    // After hydration (the fragment is browser-only). The cleanup keeps a double-run effect from reading the one-shot token twice.
    const timer = window.setTimeout(() => void start(), 0);
    // Opening a second invitation link in the same tab only changes the fragment: read that one too.
    const onHashChange = () => void start();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [start]);

  async function join(token: string) {
    setPhase({ name: "joining" });
    try {
      const res = await apiFetch<{ organizationId: string; role: string }>("/invitations/accept", {
        method: "POST",
        json: { token },
      });
      clearStashedToken();
      const form = new FormData();
      form.set("orgId", res.data.organizationId);
      await selectWorkspaceAction(form); // remembers the new workspace and opens the app
    } catch (error) {
      if (isRedirect(error)) throw error;
      const code = isClientApiError(error) ? error.code : undefined;
      setPhase({ name: "refused", token, outcome: outcomeFor(code), code });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {phase.name === "reading" || phase.name === "checking" ? (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Checking your invitation...
        </p>
      ) : null}

      {phase.name === "joining" ? (
        <p role="status" aria-busy="true" className="text-muted-foreground">
          Joining the workspace...
        </p>
      ) : null}

      {phase.name === "missing" ? (
        <Notice
          icon={<MailWarning aria-hidden="true" className="size-5" />}
          title="This page needs an invitation link"
          steps="Open the full link you were sent. If you were sent nothing yet, ask the person who invited you."
        />
      ) : null}

      {phase.name === "signin" && viewer.kind === "signed-out" ? (
        <section aria-labelledby="invite-title" className="flex flex-col gap-4">
          <h1 id="invite-title" className="text-2xl font-semibold tracking-tight">
            You have been invited to a workspace
          </h1>
          <p className="text-muted-foreground">
            Sign in, or create an account, with the email address the invitation was sent to. You
            will come back here to see the workspace and join.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={`/login${NEXT}`}>Sign in</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/signup${NEXT}`}>Create an account</Link>
            </Button>
          </div>
        </section>
      ) : null}

      {phase.name === "signin" && viewer.kind === "guest" ? (
        <section aria-labelledby="invite-title" className="flex flex-col gap-4">
          <h1 id="invite-title" className="text-2xl font-semibold tracking-tight">
            Create an account to accept this invitation
          </h1>
          <p className="text-muted-foreground">
            You are using the demo as a guest, and guests cannot join a workspace. Create an account
            with the email address the invitation was sent to; you will come back here to join.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href={`/signup${NEXT}`}>Create an account</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/login${NEXT}`}>I already have an account</Link>
            </Button>
          </div>
        </section>
      ) : null}

      {phase.name === "ready" && viewer.kind === "member" ? (
        <Offer preview={phase.preview} email={viewer.email} onJoin={() => void join(phase.token)} />
      ) : null}

      {phase.name === "refused" ? (
        <section aria-labelledby="invite-title" className="flex flex-col gap-4">
          <Notice
            icon={<ShieldAlert aria-hidden="true" className="size-5" />}
            title={phase.outcome.title}
            steps={phase.outcome.steps}
          />
          <div className="flex flex-wrap gap-3">
            {phase.code === "EMAIL_MISMATCH" ? <SwitchAccount /> : null}
            {phase.code === "EMAIL_UNVERIFIED" && phase.token ? (
              <Button type="button" variant="outline" onClick={() => void check(phase.token!)}>
                Check again
              </Button>
            ) : null}
            {phase.code === "RATE_LIMITED" || phase.code === undefined ? (
              phase.token ? (
                <Button type="button" variant="outline" onClick={() => void check(phase.token!)}>
                  Try again
                </Button>
              ) : null
            ) : null}
            {viewer.kind === "member" ? (
              <Button asChild variant="ghost">
                <Link href="/app">Go to your workspaces</Link>
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Notice({ icon, title, steps }: { icon: React.ReactNode; title: string; steps: string }) {
  return (
    <div role="alert" className="flex gap-3 rounded-lg border border-border bg-muted/50 p-4">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div>
        <h1 id="invite-title" className="font-semibold">
          {title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{steps}</p>
      </div>
    </div>
  );
}

function Offer({
  preview,
  email,
  onJoin,
}: {
  preview: InvitationPreview;
  email: string | null;
  onJoin: () => void;
}) {
  const role = ROLE_LABELS[preview.role as Role] ?? preview.role;
  const blocked = !preview.emailVerified
    ? "EMAIL_UNVERIFIED"
    : !preview.emailMatches
      ? "EMAIL_MISMATCH"
      : null;
  const outcome = blocked ? outcomeFor(blocked) : null;
  return (
    <section aria-labelledby="invite-title" className="flex flex-col gap-5">
      <div>
        <h1 id="invite-title" className="text-2xl font-semibold tracking-tight">
          Join {preview.organizationName}
        </h1>
        <p className="mt-2 text-muted-foreground">
          You have been invited to join <strong>{preview.organizationName}</strong> as{" "}
          <strong>{role.toLowerCase()}</strong>. {ROLE_HELP[preview.role as Role]}
        </p>
      </div>
      <dl className="grid gap-1 rounded-lg border border-border p-4 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6">
        <dt className="text-muted-foreground">Invited address</dt>
        <dd className="font-medium">{preview.invitedEmailHint}</dd>
        <dt className="text-muted-foreground">You are signed in as</dt>
        <dd className="font-medium break-all">{email ?? "your account"}</dd>
      </dl>
      {outcome ? (
        <Notice
          icon={<MailWarning aria-hidden="true" className="size-5" />}
          title={outcome.title}
          steps={outcome.steps}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={onJoin} disabled={blocked !== null}>
          <Check aria-hidden="true" />
          Join {preview.organizationName}
        </Button>
        {blocked === "EMAIL_MISMATCH" ? <SwitchAccount /> : null}
      </div>
    </section>
  );
}

/** Sign out and come back to sign in as the invited account. The token waits in this tab's sessionStorage. */
function SwitchAccount() {
  return (
    <form action={logoutAction}>
      <input type="hidden" name="next" value="/invite" />
      <Button type="submit" variant="outline">
        Sign out and use another account
      </Button>
    </form>
  );
}

/** Next.js implements `redirect()` by throwing; that must reach the framework, not the error handler. */
function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    String((error as { digest: unknown }).digest).startsWith("NEXT_REDIRECT")
  );
}
