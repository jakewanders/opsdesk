import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { CustomerForm } from "@/features/customers/components/customer-form";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  await connection();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;

  if (!can(ctx.role, ctx.kind, "records.write").allowed) {
    return (
      <StatePanel
        title="You can view customers but not add them"
        description="Your role in this workspace is read-only. Ask an owner or admin if you need to add customers."
        actions={
          <Link href="/app/customers" className={buttonVariants({ variant: "outline" })}>
            Back to customers
          </Link>
        }
      />
    );
  }
  return (
    <PageTransition>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-semibold tracking-tight">Add customer</h1>
        <CustomerForm currentUserId={ctx.user.id} />
      </div>
    </PageTransition>
  );
}
