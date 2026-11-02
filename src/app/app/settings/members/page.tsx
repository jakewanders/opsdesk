import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Lock } from "lucide-react";
import { MembersView } from "@/features/members/components/members-view";
import { listMembers } from "@/features/members/service";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";

export const metadata: Metadata = { title: "Members" };

/**
 * /app/settings/members. The member list is read here, on the server, with the caller's own session, so it is in the first
 * paint. A demo guest gets an explanation instead of controls: a demo is one person and has no one to invite.
 */
export default async function MembersSettingsPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  if (ctx.kind === "demo") {
    return (
      <section aria-labelledby="members-demo" className="flex flex-col gap-3">
        <h1 id="members-demo" className="text-2xl font-semibold tracking-tight">
          Members
        </h1>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Invitations are unavailable in the demo. The demo is a single-person workspace; create an
          account and a workspace of your own to invite your team.
        </p>
      </section>
    );
  }

  let initialMembers: Awaited<ReturnType<typeof listMembers>> | null = null;
  try {
    initialMembers = await listMembers(supabase, ctx);
  } catch {
    initialMembers = null; // the browser retries and shows the error with a Retry button
  }
  return (
    <MembersView
      initialMembers={initialMembers}
      actorId={ctx.user.id}
      actorRole={ctx.role}
      canManage={can(ctx.role, ctx.kind, "members.manage").allowed}
    />
  );
}
