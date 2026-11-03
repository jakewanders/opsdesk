import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { paginate } from "@/lib/validation";
import { escapeLike } from "@/features/customers/repository";
import {
  QUOTE_COLUMNS,
  toQuoteDto,
  type QuoteDto,
  type QuoteItemDto,
  type QuoteItemInput,
  type QuoteListQuery,
  type QuoteRow,
  type QuoteStatus,
} from "./schema";

type Client = SupabaseClient<Database>;

/** Maps the validated sort key to a column through a constant record: no client text reaches ORDER BY. */
const SORT_COLUMN = {
  updated_at: "updated_at",
  created_at: "created_at",
  quote_number: "quote_number",
  title: "title",
  total_cents: "total_cents",
  issue_date: "issue_date",
  status: "status",
} as const satisfies Record<QuoteListQuery["sort"], string>;

/** A value inside a PostgREST `or=(...)` filter: double-quoted, with `\` and `"` escaped, so commas and parentheses are text. */
const orValue = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

type Filterable = {
  eq(column: string, value: unknown): unknown;
  is(column: string, value: null): unknown;
  not(column: string, operator: string, value: unknown): unknown;
  gte(column: string, value: unknown): unknown;
  lte(column: string, value: unknown): unknown;
  or(filters: string): unknown;
};

/** Every filter of the list query, applied the same way to the page and to the count. Parameterized only. */
function applyListFilters<T extends Filterable>(
  request: T,
  orgId: string,
  query: QuoteListQuery,
): T {
  let r = request.eq("organization_id", orgId) as T;
  if (query.archived === "false") r = r.is("archived_at", null) as T;
  else if (query.archived === "true") r = r.not("archived_at", "is", null) as T;
  if (query.status) r = r.eq("status", query.status) as T;
  if (query.customerId) r = r.eq("customer_id", query.customerId) as T;
  if (query.opportunityId) r = r.eq("opportunity_id", query.opportunityId) as T;
  if (query.issueFrom) r = r.gte("issue_date", query.issueFrom) as T;
  if (query.issueTo) r = r.lte("issue_date", query.issueTo) as T;
  if (query.validFrom) r = r.gte("valid_until", query.validFrom) as T;
  if (query.validTo) r = r.lte("valid_until", query.validTo) as T;
  if (query.q) {
    const pattern = orValue(`%${escapeLike(query.q.toLowerCase())}%`);
    r = r.or(`quote_number.ilike.${pattern},title.ilike.${pattern}`) as T;
  }
  return r;
}

export async function listQuotes(
  supabase: Client,
  orgId: string,
  query: QuoteListQuery,
): Promise<{ items: QuoteDto[]; meta: ReturnType<typeof paginate>["meta"] }> {
  const request = applyListFilters(
    supabase.from("quotes").select(QUOTE_COLUMNS, { count: "exact" }),
    orgId,
    query,
  );
  const { from, to } = paginate(query, 0);
  const { data, error, count } = await request
    .order(SORT_COLUMN[query.sort], { ascending: query.order === "asc", nullsFirst: false })
    .order("id", { ascending: true }) // a stable order, so pages never repeat or skip a row
    .range(from, to);
  if (error) {
    // A page past the end is an empty page, not an error.
    if (error.code === "PGRST103") {
      // a page past the end is empty, and the total is still the real one
      const { count: total, error: countError } = await applyListFilters(
        supabase.from("quotes").select("id", { count: "exact", head: true }),
        orgId,
        query,
      );
      if (countError) throw countError;
      return { items: [], meta: paginate(query, total ?? 0).meta };
    }
    throw error;
  }
  return {
    items: ((data ?? []) as unknown as QuoteRow[]).map(toQuoteDto),
    meta: paginate(query, count ?? 0).meta,
  };
}

/** One quote of the workspace (archived included), or null: missing and cross-tenant look the same. */
export async function findQuote(
  supabase: Client,
  orgId: string,
  id: string,
): Promise<QuoteRow | null> {
  const { data, error } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as QuoteRow | null) ?? null;
}

export async function findItems(supabase: Client, quoteId: string): Promise<QuoteItemDto[]> {
  const { data, error } = await supabase
    .from("quote_items")
    .select("id, position, description, quantity, unit_price_cents")
    .eq("quote_id", quoteId)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((i) => ({
    id: i.id,
    position: i.position,
    description: i.description,
    quantity: i.quantity,
    unitPriceCents: Number(i.unit_price_cents),
    lineTotalCents: i.quantity * Number(i.unit_price_cents),
  }));
}

/** The revision made from this quote (one step down the chain), newest first. */
export async function findRevisions(supabase: Client, orgId: string, id: string) {
  const { data, error } = await supabase
    .from("quotes")
    .select("id, quote_number, status, created_at")
    .eq("organization_id", orgId)
    .eq("revises_quote_id", id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    quoteNumber: r.quote_number,
    status: r.status as QuoteStatus,
    createdAt: r.created_at,
  }));
}

export async function findRevised(supabase: Client, orgId: string, id: string) {
  const { data, error } = await supabase
    .from("quotes")
    .select("id, quote_number, status")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data
    ? { id: data.id, quoteNumber: data.quote_number, status: data.status as QuoteStatus }
    : null;
}

/** Status changes from the activity record (the quote's own events: created, then each `status` change). */
export async function findStatusHistory(supabase: Client, orgId: string, id: string) {
  const { data, error } = await supabase
    .from("activity_events")
    .select("action, changes, created_at")
    .eq("organization_id", orgId)
    .eq("entity_type", "quote")
    .eq("entity_id", id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  const out: Array<{ status: QuoteStatus; at: string }> = [];
  for (const e of data ?? []) {
    if (e.action === "created") out.push({ status: "draft", at: e.created_at });
    const status = (e.changes as { status?: { new?: string } } | null)?.status?.new;
    if (status) out.push({ status: status as QuoteStatus, at: e.created_at });
  }
  return out;
}

type Fields = {
  customerId: string;
  opportunityId: string | null;
  title: string;
  issueDate: string | null;
  validUntil: string | null;
  taxRateBps: number;
  discountCents: number;
  notes: string | null;
  items: QuoteItemInput[];
};

export async function rpcCreate(supabase: Client, orgId: string, f: Fields): Promise<QuoteRow> {
  const { data, error } = await supabase.rpc("create_quote_with_items", {
    p_org_id: orgId,
    p_customer_id: f.customerId,
    p_opportunity_id: f.opportunityId as string,
    p_title: f.title,
    p_issue_date: f.issueDate as string,
    p_valid_until: f.validUntil as string,
    p_tax_rate_bps: f.taxRateBps,
    p_discount_cents: f.discountCents,
    p_notes: f.notes as string,
    p_items: f.items as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as QuoteRow;
}

export async function rpcUpdate(
  supabase: Client,
  id: string,
  expectedVersion: number,
  f: Fields,
): Promise<QuoteRow> {
  const { data, error } = await supabase.rpc("update_draft_quote", {
    p_id: id,
    p_expected_version: expectedVersion,
    p_customer_id: f.customerId,
    p_opportunity_id: f.opportunityId as string,
    p_title: f.title,
    p_issue_date: f.issueDate as string,
    p_valid_until: f.validUntil as string,
    p_tax_rate_bps: f.taxRateBps,
    p_discount_cents: f.discountCents,
    p_notes: f.notes as string,
    p_items: f.items as unknown as Json,
  });
  if (error) throw error;
  return data as unknown as QuoteRow;
}

export async function rpcTransition(
  supabase: Client,
  id: string,
  expectedVersion: number,
  to: string,
): Promise<QuoteRow> {
  const { data, error } = await supabase.rpc("transition_quote", {
    p_id: id,
    p_expected_version: expectedVersion,
    p_to_status: to,
  });
  if (error) throw error;
  return data as unknown as QuoteRow;
}

export async function rpcRevise(supabase: Client, id: string): Promise<QuoteRow> {
  const { data, error } = await supabase.rpc("revise_quote", { p_id: id });
  if (error) throw error;
  return data as unknown as QuoteRow;
}
