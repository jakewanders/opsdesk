import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { OpportunitiesView } from "@/features/opportunities/components/opportunities-view";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Pipeline" };

/** /app/opportunities: the pipeline as a board or a list (`?view=`). Owners, admins and members can move deals; viewers see the board only. */
export default async function OpportunitiesPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;
  return (
    <OpportunitiesView
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      currentUserId={ctx.user.id}
    />
  );
}
