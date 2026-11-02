import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackendUnavailable } from "@/components/shared/backend-unavailable";
import { getRepoUrl } from "@/lib/env/links";
import { DemoEndedPanel } from "@/components/demo/demo-ended-panel";
import { DemoEntryClient } from "@/components/demo/demo-entry-client";
import { buttonVariants } from "@/components/ui/button";
import { loadMemberships } from "@/lib/api/org-context";
import { toWorkspaces } from "@/lib/api/organizations";
import { restartDemoAction } from "@/lib/demo/actions";
import { getPublicEnv } from "@/lib/env/public";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Live demo" };

export default async function DemoPage() {
  const user = await getCurrentUser();

  if (user && !user.isAnonymous) {
    return (
      <section aria-labelledby="demo-member-title" className="flex flex-col gap-4">
        <h1 id="demo-member-title" className="text-2xl font-semibold tracking-tight">
          You are signed in
        </h1>
        <p className="text-muted-foreground">
          The live demo is for guest visitors. Open your workspace, or sign out to try the demo.
        </p>
        <div>
          <Link href="/app" className={cn(buttonVariants(), "h-10")}>
            Open my workspace
          </Link>
        </div>
      </section>
    );
  }

  if (user?.isAnonymous) {
    // A returning guest: the same browser gets the same workspace back, or an offer to start a new one.
    let workspaces: ReturnType<typeof toWorkspaces> = [];
    try {
      workspaces = toWorkspaces(await loadMemberships(await createClient(), user.id));
    } catch {
      // Not "no workspace": the database is not answering. Say so; never start a flow that cannot finish.
      return <BackendUnavailable action="open the demo" repoUrl={getRepoUrl()} />;
    }
    const live = workspaces.some((w) => w.kind === "demo" && !w.expired);
    if (live) redirect("/app");
    if (workspaces.length > 0) return <DemoEndedPanel action={restartDemoAction} />;
  }

  const env = getPublicEnv();
  return (
    <DemoEntryClient
      siteKey={env.NEXT_PUBLIC_TURNSTILE_SITE_KEY}
      repoUrl={env.NEXT_PUBLIC_GITHUB_REPO_URL}
    />
  );
}
