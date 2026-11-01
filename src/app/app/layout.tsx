import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { getNavItems } from "@/components/layout/nav-config";
import { getFeatureFlags } from "@/lib/env/public";

// With cacheComponents enabled, `export const dynamic` is not allowed. `connection()` opts the
// shell into request-time rendering: authenticated pages are never prerendered or shared-cached
// (PRD 5.2), and env is read at runtime, not build time.
async function DynamicShell({ children }: { children: ReactNode }) {
  await connection();
  return <AppShell items={getNavItems(getFeatureFlags())}>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" aria-busy="true" />}>
      <DynamicShell>{children}</DynamicShell>
    </Suspense>
  );
}
