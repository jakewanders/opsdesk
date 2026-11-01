import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { getNavItems } from "@/components/layout/nav-config";
import { getFeatureFlags } from "@/lib/env/public";
import { getCurrentUser } from "@/lib/supabase/current-user";

// With cacheComponents enabled, `export const dynamic` is not allowed. `connection()` opts the
// shell into request-time rendering: authenticated pages are never prerendered or shared-cached
// (PRD 5.2), and env is read at runtime, not build time.
async function DynamicShell({ children }: { children: ReactNode }) {
  await connection();
  const user = await getCurrentUser();
  // TODO(SIT-180): call the auth guard here. Until sign-in ships this layout cannot know who
  // is viewing, so it says so instead of pretending the page is protected.
  return (
    <AppShell
      items={getNavItems(getFeatureFlags())}
      user={user ? { email: user.email } : null}
      banner={
        <div
          role="note"
          className="border-b border-warning/40 bg-warning-subtle px-4 py-2 text-sm text-foreground"
        >
          <strong className="font-semibold">Development build.</strong> Sign-in is not enforced yet;
          this notice goes away when authentication ships.
        </div>
      }
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
