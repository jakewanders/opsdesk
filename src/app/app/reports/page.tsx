import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ReportsView } from "@/features/reports/components/reports-view";
import { reportUrl, toApiQuery } from "@/features/reports/report-data";
import { reportQuery } from "@/features/reports/schema";
import { getReport } from "@/features/reports/service";
import { parseUrlState } from "@/lib/api-client/url-state";
import { stringifyQuery } from "@/lib/api/stringify-query";
import { getPageOrgContext } from "@/lib/org/page-context";
import { can } from "@/lib/permissions";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Reports" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /app/reports. The range in the URL is read on the server with the caller's own session (RLS applies) so the charts are in
 * the first paint; TanStack Query takes over for changes. Invalid URL values fall back to the default range.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) params.set(key, first);
  }
  const state = parseUrlState(reportUrl, params);

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let initial: Awaited<ReturnType<typeof getReport>> | null = null;
  try {
    initial = await getReport(supabase, ctx, reportQuery.parse(stringifyQuery(toApiQuery(state))));
  } catch {
    initial = null; // the browser retries and shows the error with its request id
  }
  const { data: org } = await supabase
    .from("organizations")
    .select("created_at")
    .eq("id", ctx.org.id)
    .maybeSingle();

  return (
    <PageTransition>
      <ReportsView
        initial={initial}
        initialState={state}
        canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
        isDemo={ctx.org.kind === "demo"}
        timeZone={ctx.org.timezone}
        workspaceCreatedAt={org?.created_at ?? null}
      />
    </PageTransition>
  );
}
