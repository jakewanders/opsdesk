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
  // The proxy (src/proxy.ts) redirects signed-out visitors before this renders; handlers and RLS
  // still authorize every request.
  return (
    <AppShell items={getNavItems(getFeatureFlags())} user={user ? { email: user.email } : null}>
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
