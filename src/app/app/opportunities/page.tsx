import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { PipelineBoard } from "@/features/opportunities/components/pipeline-board";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Pipeline" };

/** /app/opportunities: the pipeline board. Owners, admins and members can move deals; viewers see the board only. */
export default async function OpportunitiesPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;
  return (
    <PipelineBoard
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      currentUserId={ctx.user.id}
    />
  );
}
