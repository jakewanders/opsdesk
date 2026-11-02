import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { getNavItems } from "@/components/layout/nav-config";
import { getFeatureFlags } from "@/lib/env/public";
import { DemoCountdown } from "@/components/demo/demo-countdown";
import { loadMemberships } from "@/lib/api/org-context";
import { toWorkspaces } from "@/lib/api/organizations";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";

// With cacheComponents enabled, `export const dynamic` is not allowed. `connection()` opts the
// shell into request-time rendering: authenticated pages are never prerendered or shared-cached
// (PRD 5.2), and env is read at runtime, not build time.
async function DynamicShell({ children }: { children: ReactNode }) {
  await connection();
  const user = await getCurrentUser();
  // The proxy (src/proxy.ts) redirects signed-out visitors before this renders; handlers and RLS
  // still authorize every request.
  // A guest sees how long their demo has left (database time, never the browser clock).
  let demoExpiresAt: string | null = null;
  if (user?.isAnonymous) {
    try {
      const demo = toWorkspaces(await loadMemberships(await createClient(), user.id)).find(
        (w) => w.kind === "demo" && w.expiresAt,
      );
      demoExpiresAt = demo?.expiresAt ?? null;
    } catch {
      demoExpiresAt = null; // the banner is a convenience; never block the page on it
    }
  }
  const banner = demoExpiresAt ? (
    <DemoCountdown expiresAt={demoExpiresAt} serverNow={new Date().toISOString()} />
  ) : null;
  return (
    <AppShell
      items={getNavItems(getFeatureFlags())}
      user={user ? { email: user.email } : null}
      banner={banner}
    >
      {children}
    </AppShell>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" aria-busy="true" />}>
      <DynamicShell>{children}</DynamicShell>
    </Suspense>
  );
}
