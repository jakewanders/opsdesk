import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { OpportunityForm } from "@/features/opportunities/components/opportunity-form";
import { getForOrg } from "@/features/opportunities/service";
import { NotFoundError } from "@/lib/api/errors";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Edit opportunity" };

export default async function EditOpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const parsed = uuid().safeParse(id);
  if (!parsed.success) notFound();

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  if (!can(ctx.role, ctx.kind, "records.write").allowed) {
    return (
      <StatePanel
        title="You can view opportunities but not edit them"
        description="Your role in this workspace is read-only. Ask an owner or admin if you need to change an opportunity."
        actions={
          <Link href="/app/opportunities" className={buttonVariants({ variant: "outline" })}>
            Back to pipeline
          </Link>
        }
      />
    );
  }
  let deal;
  try {
    deal = await getForOrg(supabase, ctx, parsed.data);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <PageTransition>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Edit {deal.title}</h1>
        <OpportunityForm deal={deal} currentUserId={ctx.user.id} />
      </div>
    </PageTransition>
  );
}
