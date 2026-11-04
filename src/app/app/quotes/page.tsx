import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { QuotesView } from "@/features/quotes/components/quotes-view";
import { quoteListUrl, toApiQuery } from "@/features/quotes/list-state";
import { quoteListQuery } from "@/features/quotes/schema";
import { listForOrg } from "@/features/quotes/service";
import { parseUrlState } from "@/lib/api-client/url-state";
import { stringifyQuery } from "@/lib/api/stringify-query";
import { getFeatureFlags } from "@/lib/env/public";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Quotes" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /app/quotes. The first page is read here, on the server, with the caller's own session (RLS applies), so the table is in the first
 * paint; TanStack Query then takes over for paging, searching and filtering. The URL is the state: invalid values fall back to
 * defaults instead of failing the page. With `NEXT_PUBLIC_ENABLE_QUOTES` off the page does not exist (404).
 */
export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  if (!getFeatureFlags().quotes) notFound();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  const state = parseUrlState(quoteListUrl, params);

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let initial: Awaited<ReturnType<typeof listForOrg>> | null = null;
  try {
    initial = await listForOrg(
      supabase,
      ctx,
      quoteListQuery.parse(stringifyQuery(toApiQuery(state))),
    );
  } catch {
    initial = null; // the browser retries and shows the error with its request ID
  }

  return (
    <PageTransition>
      <QuotesView
        initial={initial}
        initialState={state}
        canWrite={can(ctx.role, ctx.kind, "quotes.write").allowed}
      />
    </PageTransition>
  );
}
