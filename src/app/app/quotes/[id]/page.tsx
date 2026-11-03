import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { QuoteEditor } from "@/features/quotes/components/quote-editor";
import { QuoteReadOnly } from "@/features/quotes/components/quote-readonly";
import { getForOrg } from "@/features/quotes/service";
import { NotFoundError } from "@/lib/api/errors";
import { getFeatureFlags } from "@/lib/env/public";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { uuid } from "@/lib/validation";

export const metadata: Metadata = { title: "Quote" };

/**
 * /app/quotes/:id. A draft is the editor for anyone who may change quotes; a sent (or later) quote, or a draft seen by a viewer,
 * is read-only, with "Create revision" for writers. The quote is read here with the caller's own session, so another workspace's
 * quote is a 404.
 */
export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  if (!getFeatureFlags().quotes) notFound();
  const { id } = await params;
  const parsed = uuid().safeParse(id);
  if (!parsed.success) notFound();

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let quote;
  try {
    quote = await getForOrg(supabase, ctx, parsed.data);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canWrite = can(ctx.role, ctx.kind, "quotes.write").allowed;
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{quote.title}</h1>
        <p className="text-sm text-muted-foreground">
          {quote.quoteNumber} ·{" "}
          {quote.status === "draft"
            ? "Draft"
            : quote.status.charAt(0).toUpperCase() + quote.status.slice(1)}
        </p>
      </header>
      {quote.status === "draft" && canWrite ? (
        <QuoteEditor quote={quote} />
      ) : (
        <QuoteReadOnly quote={quote} canWrite={canWrite} />
      )}
    </div>
  );
}
