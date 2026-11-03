import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { activityFor } from "@/features/activity/service";
import { CustomerDetail } from "@/features/customers/components/customer-detail";
import { quotesTabEnabled } from "@/features/customers/quotes-tab";
import { getForOrg } from "@/features/customers/service";
import { CustomerQuotes } from "@/features/quotes/components/customer-quotes";
import { getFeatureFlags } from "@/lib/env/public";
import { NotFoundError } from "@/lib/api/errors";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Customer" };

/**
 * /app/customers/:id. The record and its activity are read here, on the server, with the caller's own session (row level
 * security applies): a missing id, another workspace's id and a malformed id all end in the same not-found page, so
 * nothing about another tenant is ever revealed.
 */
export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  const parsed = uuid().safeParse(id);
  if (!parsed.success) notFound();

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let customer;
  try {
    customer = await getForOrg(supabase, ctx, parsed.data);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const events = await activityFor(supabase, ctx, "customer", customer.id);

  return (
    <CustomerDetail
      customer={customer}
      events={events}
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      currentUserId={ctx.user.id}
      timeZone={ctx.org.timezone}
      quotesTab={
        quotesTabEnabled(getFeatureFlags())
          ? {
              count: customer.related.quotes,
              content: (
                <CustomerQuotes
                  customerId={customer.id}
                  canWrite={can(ctx.role, ctx.kind, "quotes.write").allowed}
                />
              ),
            }
          : undefined
      }
    />
  );
}
