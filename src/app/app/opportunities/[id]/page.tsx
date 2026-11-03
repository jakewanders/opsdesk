import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { OpportunityDetail } from "@/features/opportunities/components/opportunity-detail";
import { quotesTabEnabled } from "@/features/customers/quotes-tab";
import { getForOrg } from "@/features/opportunities/service";
import { NotFoundError } from "@/lib/api/errors";
import { getFeatureFlags } from "@/lib/env/public";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Opportunity" };

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const parsed = uuid().safeParse(id);
  if (!parsed.success) notFound();

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let deal;
  try {
    // the same read the API does: a missing id and another workspace's id are both "not found"
    deal = await getForOrg(supabase, ctx, parsed.data);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <OpportunityDetail
      initial={deal}
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      quotesEnabled={quotesTabEnabled(getFeatureFlags())}
    />
  );
}
