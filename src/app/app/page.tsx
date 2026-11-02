import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DashboardView } from "@/features/dashboard/components/dashboard-view";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * /app: the dashboard. Rendered per request (it is always about the signed-in person's workspace); the numbers
 * themselves are fetched from `GET /api/v1/dashboard` by the client so they refresh after changes made elsewhere.
 */
export default async function DashboardPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;
  return (
    <DashboardView
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      currentUserId={ctx.user.id}
      timeZone={ctx.org.timezone}
    />
  );
}
