import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { findCustomer } from "@/features/customers/repository";
import { findOpportunity } from "@/features/opportunities/repository";
import { QuoteEditor } from "@/features/quotes/components/quote-editor";
import { getFeatureFlags } from "@/lib/env/public";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "New quote" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** /app/quotes/new, optionally `?customerId=` and `?opportunityId=` to start from a customer or a deal (read with the caller's own session). */
export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string | string[]; opportunityId?: string | string[] }>;
}) {
  await connection();
  if (!getFeatureFlags().quotes) notFound();
  const raw = await searchParams;
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  if (!can(ctx.role, ctx.kind, "quotes.write").allowed) {
    return (
      <StatePanel
        title="You can view quotes but not create them"
        description="Your role in this workspace is read-only. Ask an owner, admin or member if you need a quote created."
        actions={
          <Link href="/app/quotes" className={buttonVariants({ variant: "outline" })}>
            Back to quotes
          </Link>
        }
      />
    );
  }
  let initial: { customerId: string; customerName: string; opportunityId?: string } | undefined;
  const deal = uuid().safeParse(first(raw.opportunityId));
  if (deal.success) {
    const row = await findOpportunity(supabase, ctx.org.id, deal.data);
    if (row && !row.archived_at) {
      const customer = await findCustomer(supabase, ctx.org.id, row.customer_id);
      if (customer && !customer.archived_at)
        initial = {
          customerId: customer.id,
          customerName: customer.display_name,
          opportunityId: row.id,
        };
    }
  }
  const cust = uuid().safeParse(first(raw.customerId));
  if (!initial && cust.success) {
    const customer = await findCustomer(supabase, ctx.org.id, cust.data);
    if (customer && !customer.archived_at)
      initial = { customerId: customer.id, customerName: customer.display_name };
  }
  return (
    <PageTransition>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">New quote</h1>
        <QuoteEditor initial={initial} />
      </div>
    </PageTransition>
  );
}
