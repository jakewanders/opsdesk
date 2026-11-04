import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { ImportWizard } from "@/features/customers/import/components/import-wizard";
import { getFeatureFlags } from "@/lib/env/public";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Import customers" };

/**
 * /app/customers/import: the CSV import wizard. With `NEXT_PUBLIC_ENABLE_CSV_IMPORT` off the page does not exist (404). Importing
 * writes customers, so anyone who cannot add customers is told so instead of being shown a flow that would be refused.
 */
export default async function ImportCustomersPage() {
  await connection();
  if (!getFeatureFlags().csvImport) notFound();
  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx } = page;

  if (!can(ctx.role, ctx.kind, "records.write").allowed) {
    return (
      <StatePanel
        title="You can view customers but not import them"
        description="Your role in this workspace is read-only. Ask an owner or admin if you need to import customers."
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
      <ImportWizard isDemo={ctx.kind === "demo"} />
    </PageTransition>
  );
}
