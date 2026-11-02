import type { SupabaseClient } from "@supabase/supabase-js";
import { paginate } from "@/lib/validation";
import type { Database } from "@/lib/supabase/database.types";
import {
  CUSTOMER_COLUMNS,
  toCustomerDto,
  type CreateCustomerInput,
  type CustomerDto,
  type CustomerListQuery,
  type CustomerRow,
} from "./schema";

type Client = SupabaseClient<Database>;

/** Maps the validated sort key to a column through a constant record: no client text reaches ORDER BY. */
const SORT_COLUMN = {
  updated_at: "updated_at",
  created_at: "created_at",
  display_name: "display_name",
  status: "status",
} as const satisfies Record<CustomerListQuery["sort"], string>;

/** Escapes `\`, `%` and `_` so user text is matched literally by ILIKE. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One page of customers of `orgId`, read with the caller's own session so RLS applies (the explicit organization
 * filter is a second line of defence and keeps the planner on the organization's index). Parameterized only.
 */
export async function listCustomers(
  supabase: Client,
  orgId: string,
  query: CustomerListQuery,
): Promise<{ items: CustomerDto[]; meta: ReturnType<typeof paginate>["meta"] }> {
  let request = supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS, { count: "exact" })
    .eq("organization_id", orgId);

  if (query.archived === "false") request = request.is("archived_at", null);
  else if (query.archived === "true") request = request.not("archived_at", "is", null);
  if (query.status) request = request.eq("status", query.status);
  if (query.source) request = request.eq("source", query.source);
  if (query.assignedTo) request = request.eq("assigned_to", query.assignedTo);
  if (query.q) request = request.ilike("search_text", `%${escapeLike(query.q.toLowerCase())}%`);

  const { from, to } = paginate(query, 0);
  const { data, error, count } = await request
    .order(SORT_COLUMN[query.sort], { ascending: query.order === "asc" })
    .order("id", { ascending: true }) // a stable order, so pages never repeat or skip a row
    .range(from, to);

  if (error) {
    // A page past the end is an empty page, not an error.
    if (error.code === "PGRST103") {
      const total = await countCustomers(supabase, orgId, query);
      return { items: [], meta: paginate(query, total).meta };
    }
    throw error;
  }
  return {
    items: ((data ?? []) as unknown as CustomerRow[]).map(toCustomerDto),
    meta: paginate(query, count ?? 0).meta,
  };
}

async function countCustomers(
  supabase: Client,
  orgId: string,
  query: CustomerListQuery,
): Promise<number> {
  let request = supabase
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId);
  if (query.archived === "false") request = request.is("archived_at", null);
  else if (query.archived === "true") request = request.not("archived_at", "is", null);
  if (query.status) request = request.eq("status", query.status);
  if (query.source) request = request.eq("source", query.source);
  if (query.assignedTo) request = request.eq("assigned_to", query.assignedTo);
  if (query.q) request = request.ilike("search_text", `%${escapeLike(query.q.toLowerCase())}%`);
  const { count, error } = await request;
  if (error) throw error;
  return count ?? 0;
}

export async function insertCustomer(
  supabase: Client,
  orgId: string,
  input: CreateCustomerInput,
): Promise<CustomerDto> {
  const { data, error } = await supabase
    .from("customers")
    .insert({
      organization_id: orgId,
      type: input.type,
      display_name: input.displayName,
      company_name: input.companyName,
      email: input.email,
      phone: input.phone,
      website: input.website,
      status: input.status,
      source: input.source,
      tags: input.tags,
      notes: input.notes,
      assigned_to: input.assignedTo,
    })
    .select(CUSTOMER_COLUMNS)
    .single();
  if (error) throw error;
  return toCustomerDto(data as unknown as CustomerRow);
}

/** Another customer of the organization with this e-mail (archived ones included), or null. */
export async function findOtherCustomerWithEmail(
  supabase: Client,
  orgId: string,
  email: string,
  excludeId: string,
): Promise<{ id: string; displayName: string } | null> {
  const { data, error } = await supabase
    .from("customers")
    .select("id, display_name")
    .eq("organization_id", orgId)
    .eq("email", email)
    .neq("id", excludeId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row ? { id: row.id, displayName: row.display_name } : null;
}
