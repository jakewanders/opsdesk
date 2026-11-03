import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { getNavItems } from "@/components/layout/nav-config";
import { getFeatureFlags } from "@/lib/env/public";
import { DemoCountdown } from "@/components/demo/demo-countdown";
import { FictionalDataNote } from "@/components/demo/fictional-data-note";
import { GuestModeProvider } from "@/components/demo/restricted-action";
import { DemoResetButton } from "@/components/demo/demo-reset-button";
import { loadMemberships } from "@/lib/api/org-context";
import { toWorkspaces } from "@/lib/api/organizations";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { cookies } from "next/headers";
import { BackendUnavailable } from "@/components/shared/backend-unavailable";
import { getRepoUrl } from "@/lib/env/links";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { OrgSelector } from "@/components/org/org-selector";
import { ACTIVE_ORG_COOKIE, resolveActiveWorkspace } from "@/lib/org/active-org";
import { selectWorkspaceAction } from "@/lib/org/actions";
import type { WorkspaceSummary } from "@/lib/api/organizations";

// The application is never indexed (SIT-273); robots.txt disallows it too.
export const metadata: Metadata = { robots: { index: false, follow: false } };

// With cacheComponents enabled, `export const dynamic` is not allowed. `connection()` opts the
// shell into request-time rendering: authenticated pages are never prerendered or shared-cached
// (PRD 5.2), and env is read at runtime, not build time.
async function loadDisplayName(userId: string): Promise<string | null> {
  try {
    const { data } = await (
      await createClient()
    )
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    return data?.display_name ?? null;
  } catch {
    return null;
  }
}

async function DynamicShell({ children }: { children: ReactNode }) {
  await connection();
  const user = await getCurrentUser();
  // The proxy (src/proxy.ts) redirects signed-out visitors before this renders; handlers and RLS
  // still authorize every request.
  // The caller's own workspaces (RLS), for the selector, the active workspace and a guest's countdown.
  let workspaces: WorkspaceSummary[] = [];
  let demoExpiresAt: string | null = null;
  if (user) {
    try {
      workspaces = toWorkspaces(await loadMemberships(await createClient(), user.id));
      if (user.isAnonymous) {
        // A guest sees how long their demo has left (database time, never the browser clock).
        demoExpiresAt = workspaces.find((w) => w.kind === "demo" && w.expiresAt)?.expiresAt ?? null;
      }
    } catch {
      // The workspace list is how the shell knows who this is. If the database does not answer, say so instead of
      // rendering an empty shell that looks like a workspace with no data.
      return (
        <main
          id="main-content"
          className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6"
        >
          <BackendUnavailable action="load your workspace" repoUrl={getRepoUrl()} />
        </main>
      );
    }
  }
  // The cookie is only a preference: it counts only if it names one of the caller's own workspaces.
  const active = resolveActiveWorkspace(
    (await cookies()).get(ACTIVE_ORG_COOKIE)?.value,
    workspaces,
  );
  const displayName = user ? await loadDisplayName(user.id) : null;
  const banner = demoExpiresAt ? (
    <DemoCountdown
      expiresAt={demoExpiresAt}
      serverNow={new Date().toISOString()}
      actions={<DemoResetButton />}
    />
  ) : null;
  const activeOrgId = active.status === "selected" ? active.workspace.id : null;
  return (
    // One client cache per user and workspace: the key makes a switch start with an empty cache.
    <ApiClientProvider
      key={`${user?.id ?? "anon"}:${activeOrgId ?? "none"}`}
      organizationId={activeOrgId}
    >
      <AppShell
        items={getNavItems(getFeatureFlags())}
        user={user ? { email: user.email, name: displayName, isGuest: user.isAnonymous } : null}
        orgSelector={
          user ? (
            <OrgSelector
              workspaces={workspaces}
              activeId={activeOrgId}
              selectAction={selectWorkspaceAction}
              canCreate={!user.isAnonymous}
            />
          ) : undefined
        }
        banner={banner}
        footer={user?.isAnonymous ? <FictionalDataNote /> : undefined}
      >
        <GuestModeProvider isGuest={Boolean(user?.isAnonymous)}>{children}</GuestModeProvider>
      </AppShell>
    </ApiClientProvider>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" aria-busy="true" />}>
      <DynamicShell>{children}</DynamicShell>
    </Suspense>
  );
}
