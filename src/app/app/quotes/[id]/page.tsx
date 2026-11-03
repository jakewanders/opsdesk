import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { ActivityTimeline } from "@/features/activity/components/activity-timeline";
import { activityFor } from "@/features/activity/service";
import { listMembers } from "@/features/members/service";
import { QuoteActions } from "@/features/quotes/components/quote-actions";
import { QuoteEditor } from "@/features/quotes/components/quote-editor";
import { QuoteHeader } from "@/features/quotes/components/quote-header";
import { RevisionChain } from "@/features/quotes/components/revision-chain";
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
  const [events, members] = await Promise.all([
    activityFor(supabase, ctx, "quote", quote.id),
    listMembers(supabase, ctx).catch(() => []),
  ]);
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? "A teammate";
  return (
    <div className="flex flex-col gap-5">
      <QuoteHeader quote={quote} />
      <QuoteActions
        quote={{
          id: quote.id,
          quoteNumber: quote.quoteNumber,
          status: quote.status,
          version: quote.version,
        }}
        canWrite={canWrite}
        isDemo={ctx.kind === "demo"}
      />
      <RevisionChain quote={quote} />
      {quote.status === "draft" && canWrite ? (
        <QuoteEditor quote={quote} />
      ) : (
        <QuoteReadOnly quote={quote} canWrite={canWrite} />
      )}
      <section aria-labelledby="quote-history-title" className="flex flex-col gap-3">
        <h2 id="quote-history-title" className="text-lg font-semibold">
          History
        </h2>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No history has been recorded for this quote yet.
          </p>
        ) : (
          <ActivityTimeline
            label="Quote history"
            timeZone={ctx.org.timezone}
            items={events.map((event) => ({
              id: event.id,
              action: event.action,
              summary: event.summary,
              actorName: event.actorUserId === null ? "System" : nameOf(event.actorUserId),
              createdAt: event.createdAt,
              changes: event.changes,
              contentChanged: event.contentChanged,
            }))}
          />
        )}
      </section>
    </div>
  );
}
