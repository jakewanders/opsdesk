import type { SupabaseClient } from "@supabase/supabase-js";
import { updateIfCurrent } from "@/lib/api/concurrency";
import { totalsByStage, pipelineTotal, weightedPipeline, type Stage } from "@/lib/domain/pipeline";
import type { Database } from "@/lib/supabase/database.types";
import { paginate } from "@/lib/validation";
import { escapeLike } from "@/features/customers/repository";
import {
  OPPORTUNITY_COLUMNS,
  PATCH_COLUMNS,
  toOpportunityDto,
  type CreateOpportunityInput,
  type OpportunityDto,
  type OpportunityListQuery,
  type OpportunityRow,
  type UpdateOpportunityInput,
} from "./schema";

type Client = SupabaseClient<Database>;

/** Maps the validated sort key to a column through a constant record: no client text reaches ORDER BY. */
const SORT_COLUMN = {
  updated_at: "updated_at",
  created_at: "created_at",
  title: "title",
  amount_cents: "amount_cents",
  expected_close_date: "expected_close_date",
  stage: "stage",
} as const satisfies Record<OpportunityListQuery["sort"], string>;

/** The most rows the per-stage totals read; a workspace with more reports `aggregatesComplete: false`. */
const AGGREGATE_ROW_LIMIT = 5000;
/** The most customers matched by name for one search. */
const SEARCH_CUSTOMER_LIMIT = 200;

/** A value inside a PostgREST `or=(...)` filter: double-quoted, with `\` and `"` escaped, so commas and parentheses are text. */
const orValue = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** Ids of the organization's customers whose name, company or e-mail matches the search text. */
async function matchingCustomerIds(supabase: Client, orgId: string, q: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("customers")
    .select("id")
    .eq("organization_id", orgId)
    .ilike("search_text", `%${escapeLike(q.toLowerCase())}%`)
    .limit(SEARCH_CUSTOMER_LIMIT);
  if (error) throw error;
  return (data ?? []).map((c) => c.id);
}

/** Applies every filter of the list query (the same set for the page, the count and the totals). */
type Filterable = {
  eq(column: string, value: unknown): unknown;
  is(column: string, value: null): unknown;
  not(column: string, operator: string, value: unknown): unknown;
  gte(column: string, value: unknown): unknown;
  lte(column: string, value: unknown): unknown;
  or(filters: string): unknown;
};

function applyFilters<T extends Filterable>(
  request: T,
  orgId: string,
  query: OpportunityListQuery,
  customerIds: string[] | null,
): T {
  let r = request.eq("organization_id", orgId) as T;
  if (query.archived === "false") r = r.is("archived_at", null) as T;
  else if (query.archived === "true") r = r.not("archived_at", "is", null) as T;
  if (query.stage) r = r.eq("stage", query.stage) as T;
  if (query.assignedTo) r = r.eq("assigned_to", query.assignedTo) as T;
  if (query.customerId) r = r.eq("customer_id", query.customerId) as T;
  if (query.closeFrom) r = r.gte("expected_close_date", query.closeFrom) as T;
  if (query.closeTo) r = r.lte("expected_close_date", query.closeTo) as T;
  if (query.amountMin !== undefined) r = r.gte("amount_cents", query.amountMin) as T;
  if (query.amountMax !== undefined) r = r.lte("amount_cents", query.amountMax) as T;
  if (query.q) {
    const pattern = orValue(`%${escapeLike(query.q.toLowerCase())}%`);
    const parts = [`title.ilike.${pattern}`];
    if (customerIds && customerIds.length > 0)
      parts.push(`customer_id.in.(${customerIds.join(",")})`);
    r = r.or(parts.join(",")) as T;
  }
  return r;
}

export type PipelineMeta = {
  stageTotals: ReturnType<typeof totalsByStage>;
  openPipelineCents: number;
  weightedPipelineCents: number;
  aggregatesComplete: boolean;
};

/** Per-stage counts and the open-pipeline sums for the filtered set, computed with the shared pipeline module. */
async function pipelineMeta(
  supabase: Client,
  orgId: string,
  query: OpportunityListQuery,
  customerIds: string[] | null,
): Promise<PipelineMeta> {
  const request = applyFilters(
    supabase
      .from("opportunities")
      .select("stage, amount_cents, probability_percent", { count: "exact" }),
    orgId,
    query,
    customerIds,
  );
  const { data, error, count } = await request.range(0, AGGREGATE_ROW_LIMIT - 1);
  if (error) throw error;
  const rows = (data ?? []).map((r) => ({
    stage: r.stage as Stage,
    amountCents: Number(r.amount_cents),
    probability: r.probability_percent ?? undefined,
  }));
  return {
    stageTotals: totalsByStage(rows),
    openPipelineCents: pipelineTotal(rows),
    weightedPipelineCents: weightedPipeline(rows),
    aggregatesComplete: (count ?? rows.length) <= AGGREGATE_ROW_LIMIT,
  };
}

/**
 * One page of opportunities of `orgId`, read with the caller's own session so RLS applies (the explicit organization
 * filter is a second line of defence). Parameterized only.
 */
export async function listOpportunities(
  supabase: Client,
  orgId: string,
  query: OpportunityListQuery,
): Promise<{
  items: OpportunityDto[];
  meta: ReturnType<typeof paginate>["meta"] & PipelineMeta;
}> {
  const customerIds = query.q ? await matchingCustomerIds(supabase, orgId, query.q) : null;
  const totals = await pipelineMeta(supabase, orgId, query, customerIds);

  const { from, to } = paginate(query, 0);
  const request = applyFilters(
    supabase.from("opportunities").select(OPPORTUNITY_COLUMNS, { count: "exact" }),
    orgId,
    query,
    customerIds,
  );
  const { data, error, count } = await request
    .order(SORT_COLUMN[query.sort], { ascending: query.order === "asc", nullsFirst: false })
    .order("id", { ascending: true }) // a stable order, so pages never repeat or skip a row
    .range(from, to);

  if (error) {
    // A page past the end is an empty page, not an error.
    if (error.code === "PGRST103") {
      const total = Object.values(totals.stageTotals).reduce((n, s) => n + s.count, 0);
      return { items: [], meta: { ...paginate(query, total).meta, ...totals } };
    }
    throw error;
  }
  return {
    items: ((data ?? []) as unknown as OpportunityRow[]).map(toOpportunityDto),
    meta: { ...paginate(query, count ?? 0).meta, ...totals },
  };
}

export async function insertOpportunity(
  supabase: Client,
  orgId: string,
  input: CreateOpportunityInput,
): Promise<OpportunityDto> {
  const { data, error } = await supabase
    .from("opportunities")
    .insert({
      organization_id: orgId,
      customer_id: input.customerId,
      title: input.title,
      description: input.description,
      stage: input.stage,
      amount_cents: input.amountCents,
      // left out: the database applies the stage's default probability
      ...(input.probabilityPercent === undefined
        ? {}
        : { probability_percent: input.probabilityPercent }),
      expected_close_date: input.expectedCloseDate,
      assigned_to: input.assignedTo,
    })
    .select(OPPORTUNITY_COLUMNS)
    .single();
  if (error) throw error;
  return toOpportunityDto(data as unknown as OpportunityRow);
}

/** One opportunity of the organization (archived included), or null: missing and cross-tenant look the same. */
export async function findOpportunity(
  supabase: Client,
  orgId: string,
  id: string,
): Promise<OpportunityRow | null> {
  const { data, error } = await supabase
    .from("opportunities")
    .select(OPPORTUNITY_COLUMNS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as OpportunityRow | null) ?? null;
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The columns the patch would actually change, as `{ column: newValue }`. Empty when the patch is a no-op. */
export function changedColumns(
  current: OpportunityRow,
  patch: Omit<UpdateOpportunityInput, "expectedUpdatedAt" | "stage">,
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
export async function updateOpportunity(
  supabase: Client,
  id: string,
  expectedUpdatedAt: string,
  columns: Record<string, unknown>,
): Promise<OpportunityDto> {
  const row = await updateIfCurrent(supabase as never, {
    table: "opportunities",
    id,
    expected: { updatedAt: expectedUpdatedAt },
    patch: columns,
    columns: OPPORTUNITY_COLUMNS,
  });
  return toOpportunityDto(row as unknown as OpportunityRow);
}

/** Archive (`archived_at = now()`). Idempotent: an already archived row is left alone. */
export async function archiveOpportunity(
  supabase: Client,
  orgId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("opportunities")
    .update({ archived_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("archived_at", null);
  if (error) throw error;
}

/**
 * Calls the database function that performs a stage change (one transaction: checks, update, probability reset,
 * `closed_at` and `lost_reason` rules, and the `stage_changed` event). Returns "stale" when the deal changed between the
 * caller's read and the update (the function's compare-and-set), otherwise the updated deal with its customer's name.
 */
export async function moveStage(
  supabase: Client,
  orgId: string,
  id: string,
  stage: string,
  lostReason: string | null,
  expectedUpdatedAt: string,
): Promise<OpportunityDto | "stale"> {
  const { error } = await supabase.rpc("move_opportunity_stage", {
    p_id: id,
    p_new_stage: stage,
    // the generated type says string; the function accepts null (no reason)
    p_lost_reason: lostReason as string,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (error) {
    if (error.code === "OD409" && error.details === "STALE_EDIT") return "stale";
    throw error;
  }
  const row = await findOpportunity(supabase, orgId, id);
  if (!row) throw new Error("The opportunity disappeared after its stage changed.");
  return toOpportunityDto(row);
}
