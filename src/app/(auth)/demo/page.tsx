import type { Metadata } from "next";
import { DemoEndedPanel } from "@/components/demo/demo-ended-panel";
import { PlannedPage } from "@/components/shared/planned-page";
import { loadMemberships } from "@/lib/api/org-context";
import { toWorkspaces } from "@/lib/api/organizations";
import { restartDemoAction } from "@/lib/demo/actions";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Live demo" };

/** True when the visitor is a guest whose only demo workspace has expired (read with their own session). */
async function hasExpiredDemo(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user?.isAnonymous) return false;
  try {
    const workspaces = toWorkspaces(await loadMemberships(await createClient(), user.id));
    return workspaces.length > 0 && workspaces.every((w) => w.kind === "demo" && w.expired);
  } catch {
    return false;
  }
}

export default async function DemoPage() {
  if (await hasExpiredDemo()) return <DemoEndedPanel action={restartDemoAction} />;
  // The entry flow for a new visitor (CAPTCHA, anonymous sign-in, bootstrap) is SIT-204.
  return (
    <PlannedPage
      title="Live demo"
      summary="Open a private workspace filled with fictional data, with no sign-up."
      milestone="M1"
      backHref="/"
      backLabel="Back to home"
    />
  );
}
