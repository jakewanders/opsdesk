import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { CustomersView } from "@/features/customers/components/customers-view";
import { customerListUrl, toApiQuery } from "@/features/customers/list-state";
import { customerListQuery } from "@/features/customers/schema";
import { listForOrg } from "@/features/customers/service";
import { can } from "@/lib/permissions";
import { parseUrlState } from "@/lib/api-client/url-state";
import { stringifyQuery } from "@/lib/api/stringify-query";
import { getPageOrgContext } from "@/lib/org/page-context";

export const metadata: Metadata = { title: "Customers" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /app/customers. The first page is read here, on the server, with the caller's own session (RLS applies), so the
 * table is in the first paint; TanStack Query then takes over for paging, searching and filtering. The URL is the
 * state: invalid values fall back to defaults instead of failing the page.
 */
export default async function CustomersPage({
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
  const state = parseUrlState(customerListUrl, params);

  const page = await getPageOrgContext();
  if (!page) redirect("/app/workspaces");
  const { ctx, supabase } = page;

  let initial: Awaited<ReturnType<typeof listForOrg>> | null = null;
  try {
    initial = await listForOrg(
      supabase,
      ctx,
      customerListQuery.parse(stringifyQuery(toApiQuery(state))),
    );
  } catch {
    initial = null; // the browser retries and shows the error with its request ID
  }

  return (
    <CustomersView
      initial={initial}
      initialState={state}
      canWrite={can(ctx.role, ctx.kind, "records.write").allowed}
      currentUserId={ctx.user.id}
      timeZone={ctx.org.timezone}
    />
  );
}
