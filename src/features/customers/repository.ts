import type { SupabaseClient } from "@supabase/supabase-js";
import { updateIfCurrent } from "@/lib/api/concurrency";
import { dayRangeBounds } from "@/lib/domain/day-range";
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
import { PATCH_COLUMNS, type UpdateCustomerInput } from "./schema";

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
 * A Postgres text-array literal with every element quoted and escaped (`{"vip","a\"b"}`), so tag text with commas, quotes, braces or
 * backslashes is data and not array syntax. (The client library's own `contains` joins the elements unquoted.)
 */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`).join(",")}}`;
}

type Filterable = {
  eq(column: string, value: unknown): unknown;
  is(column: string, value: null): unknown;
  not(column: string, operator: string, value: unknown): unknown;
  gte(column: string, value: unknown): unknown;
  lt(column: string, value: unknown): unknown;
  filter(column: string, operator: string, value: unknown): unknown;
  ilike(column: string, pattern: string): unknown;
};

/** Every filter of the list query, applied the same way to the page and to the count. Parameterized only. */
function applyFilters<T extends Filterable>(
  request: T,
  orgId: string,
  query: CustomerListQuery,
  timeZone: string,
): T {
  let r = request.eq("organization_id", orgId) as T;
  if (query.archived === "false") r = r.is("archived_at", null) as T;
  else if (query.archived === "true") r = r.not("archived_at", "is", null) as T;
  if (query.status) r = r.eq("status", query.status) as T;
  if (query.source) r = r.eq("source", query.source) as T;
  if (query.assignedTo) r = r.eq("assigned_to", query.assignedTo) as T;
  if (query.tags) r = r.filter("tags", "cs", pgTextArray(query.tags)) as T;
  const created = dayRangeBounds({ from: query.createdFrom, to: query.createdTo }, timeZone);
  if (created.gte) r = r.gte("created_at", created.gte) as T;
  if (created.lt) r = r.lt("created_at", created.lt) as T;
  const updated = dayRangeBounds({ from: query.updatedFrom, to: query.updatedTo }, timeZone);
  if (updated.gte) r = r.gte("updated_at", updated.gte) as T;
  if (updated.lt) r = r.lt("updated_at", updated.lt) as T;
  if (query.q) r = r.ilike("search_text", `%${escapeLike(query.q.toLowerCase())}%`) as T;
  return r;
}

/**
 * One page of customers of `orgId`, read with the caller's own session so RLS applies (the explicit organization
 * filter is a second line of defence and keeps the planner on the organization's index). Parameterized only. `timeZone`
 * is the workspace's, for the created / updated day ranges.
 */
export async function listCustomers(
  supabase: Client,
  orgId: string,
  query: CustomerListQuery,
  timeZone = "UTC",
): Promise<{ items: CustomerDto[]; meta: ReturnType<typeof paginate>["meta"] }> {
  const request = applyFilters(
    supabase.from("customers").select(CUSTOMER_COLUMNS, { count: "exact" }),
    orgId,
    query,
    timeZone,
  );
  const { from, to } = paginate(query, 0);
  const { data, error, count } = await request
    .order(SORT_COLUMN[query.sort], { ascending: query.order === "asc" })
    .order("id", { ascending: true }) // a stable order, so pages never repeat or skip a row
    .range(from, to);

  if (error) {
    // A page past the end is an empty page, not an error.
    if (error.code === "PGRST103") {
      const total = await countCustomers(supabase, orgId, query, timeZone);
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
  timeZone: string,
): Promise<number> {
  const { count, error } = await applyFilters(
    supabase.from("customers").select("id", { count: "exact", head: true }),
    orgId,
    query,
    timeZone,
  );
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

/** One customer of the organization (archived included), or null: missing and cross-tenant look the same. */
export async function findCustomer(
  supabase: Client,
  orgId: string,
  id: string,
): Promise<CustomerRow | null> {
  const { data, error } = await supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as CustomerRow | null) ?? null;
}

/** What hangs off a customer: its opportunities, tasks and (active) quotes. */
export async function countRelated(supabase: Client, orgId: string, id: string) {
  const count = (table: "opportunities" | "tasks") =>
    supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("customer_id", id);
  const [opportunities, tasks, openOpportunities, openTasks] = await Promise.all([
    count("opportunities"),
    count("tasks"),
    count("opportunities")
      .in("stage", ["new", "qualified", "proposal", "negotiation"])
      .is("archived_at", null),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("customer_id", id)
      .neq("status", "done")
      .is("archived_at", null),
  ]);
  const quotes = await supabase
    .from("quotes")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("customer_id", id)
    .is("archived_at", null);
  for (const r of [opportunities, tasks, openOpportunities, openTasks, quotes])
    if (r.error) throw r.error;
  return {
    opportunities: opportunities.count ?? 0,
    tasks: tasks.count ?? 0,
    quotes: quotes.count ?? 0,
    openOpportunities: openOpportunities.count ?? 0,
    openTasks: openTasks.count ?? 0,
  };
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The columns the patch would actually change, as `{ column: newValue }`. Empty when the patch is a no-op. */
export function changedColumns(
  current: CustomerRow,
  patch: Omit<UpdateCustomerInput, "expectedUpdatedAt">,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(PATCH_COLUMNS)) {
    const value = (patch as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!sameValue((current as unknown as Record<string, unknown>)[column], value))
      out[column] = value;
  }
  return out;
}

/** Compare-and-set update: only matches the version the client saw (SIT-183). */
export async function updateCustomer(
  supabase: Client,
  id: string,
  expectedUpdatedAt: string,
  columns: Record<string, unknown>,
): Promise<CustomerDto> {
  const row = await updateIfCurrent(supabase as never, {
    table: "customers",
    id,
    expected: { updatedAt: expectedUpdatedAt },
    patch: columns,
    columns: CUSTOMER_COLUMNS,
  });
  return toCustomerDto(row as unknown as CustomerRow);
}

/** Archive (`archived_at = now()`) or restore (`null`). Idempotent: a row already in that state is left alone. */
export async function setArchived(
  supabase: Client,
  orgId: string,
  id: string,
  archive: boolean,
): Promise<CustomerDto | null> {
  const query = supabase
    .from("customers")
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq("organization_id", orgId)
    .eq("id", id);
  const { data, error } = await (
    archive ? query.is("archived_at", null) : query.not("archived_at", "is", null)
  ).select(CUSTOMER_COLUMNS);
  if (error) throw error;
  const row = (data as unknown as CustomerRow[] | null)?.[0];
  return row ? toCustomerDto(row) : null;
}
