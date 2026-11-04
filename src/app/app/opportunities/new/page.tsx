import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { findCustomer } from "@/features/customers/repository";
import { OpportunityForm } from "@/features/opportunities/components/opportunity-form";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Add opportunity" };

/** /app/opportunities/new, optionally `?customerId=` to start with a customer (read with the caller's session, so only a visible one is used). */
export default async function NewOpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string | string[] }>;
}) {
  await connection();
  const raw = (await searchParams).customerId;
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  if (!can(ctx.role, ctx.kind, "records.write").allowed) {
    return (
      <StatePanel
        title="You can view opportunities but not add them"
        description="Your role in this workspace is read-only. Ask an owner or admin if you need to add opportunities."
        actions={
          <Link href="/app/opportunities" className={buttonVariants({ variant: "outline" })}>
            Back to pipeline
          </Link>
        }
      />
    );
  }
  let initialCustomer: { id: string; name: string } | undefined;
  const candidate = uuid().safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (candidate.success) {
    const customer = await findCustomer(supabase, ctx.org.id, candidate.data);
    if (customer && !customer.archived_at)
      initialCustomer = { id: customer.id, name: customer.display_name };
  }
  return (
    <PageTransition>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Add opportunity</h1>
        <OpportunityForm initialCustomer={initialCustomer} currentUserId={ctx.user.id} />
      </div>
    </PageTransition>
  );
}
