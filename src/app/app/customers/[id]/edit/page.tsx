import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { CustomerForm } from "@/features/customers/components/customer-form";
import { getForOrg } from "@/features/customers/service";
import { NotFoundError } from "@/lib/api/errors";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Edit customer" };

export default async function EditCustomerPage({ params }: { params: Promise<{ id: string }> }) {
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
        title="You can view customers but not edit them"
        description="Your role in this workspace is read-only. Ask an owner or admin if you need to change a customer."
        actions={
          <Link href="/app/customers" className={buttonVariants({ variant: "outline" })}>
            Back to customers
          </Link>
        }
      />
    );
  }

  let customer;
  try {
    // the same read the API does: missing and another workspace's customer are both "not found"
    const { related: _related, ...rest } = await getForOrg(supabase, ctx, parsed.data);
    void _related;
    customer = rest;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  return (
    <PageTransition>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Edit {customer.displayName}</h1>
        <CustomerForm customer={customer} currentUserId={ctx.user.id} />
      </div>
    </PageTransition>
  );
}
