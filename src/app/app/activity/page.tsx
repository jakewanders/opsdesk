import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ActivityView } from "@/features/activity/components/activity-view";
import { getPageOrgContext } from "@/lib/org/page-context";

export const metadata: Metadata = { title: "Activity" };

/** /app/activity: the workspace's change history. Any member (viewers included) can read it. */
export default async function ActivityPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;
  return <ActivityView currentUserId={ctx.user.id} timeZone={ctx.org.timezone} />;
}
