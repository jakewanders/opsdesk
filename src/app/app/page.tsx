import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DashboardView } from "@/features/dashboard/components/dashboard-view";
import { getDashboard } from "@/features/dashboard/service";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * /app: the dashboard. Rendered per request (it is always about the signed-in person's workspace); the numbers
 * themselves are fetched from `GET /api/v1/dashboard` by the client so they refresh after changes made elsewhere.
 */
export default async function DashboardPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;
  // read on the server with the caller's own session so the numbers are in the first paint; the client takes over for refreshes
  const initial = await getDashboard(supabase, ctx).catch(() => null);
  return (
    <PageTransition>
      <DashboardView
        initial={initial}
        canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
        currentUserId={ctx.user.id}
        timeZone={ctx.org.timezone}
      />
    </PageTransition>
  );
}
