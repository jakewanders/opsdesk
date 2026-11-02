import type { SupabaseClient } from "@supabase/supabase-js";
import { updateIfCurrent } from "@/lib/api/concurrency";
import type { Database } from "@/lib/supabase/database.types";
import { paginate } from "@/lib/validation";
import { escapeLike } from "@/features/customers/repository";
import {
  PATCH_COLUMNS,
  TASK_COLUMNS,
  toTaskDto,
  type CreateTaskInput,
  type TaskDto,
  type TaskListQuery,
  type TaskRow,
  type UpdateTaskInput,
} from "./schema";

type Client = SupabaseClient<Database>;

/** Maps the validated sort key to a column through a constant record: no client text reaches ORDER BY. */
const SORT_COLUMN = {
  due_date: "due_date",
  priority: "priority_rank",
  created_at: "created_at",
  updated_at: "updated_at",
  title: "title",
} as const satisfies Record<TaskListQuery["sort"], string>;

type Filterable = {
  eq(column: string, value: unknown): unknown;
  is(column: string, value: null): unknown;
  not(column: string, operator: string, value: unknown): unknown;
  neq(column: string, value: unknown): unknown;
  lt(column: string, value: unknown): unknown;
  ilike(column: string, pattern: string): unknown;
};

/** What the filters need beyond the query itself: who is asking and what "today" is in the organization's zone. */
export type TaskScope = { orgId: string; userId: string; today: string };

function applyFilters<T extends Filterable>(request: T, scope: TaskScope, query: TaskListQuery): T {
  let r = request.eq("organization_id", scope.orgId) as T;
  if (query.archived === "false") r = r.is("archived_at", null) as T;
  else if (query.archived === "true") r = r.not("archived_at", "is", null) as T;
  if (query.status) r = r.eq("status", query.status) as T;
  if (query.priority) r = r.eq("priority", query.priority) as T;
  if (query.assignedTo) r = r.eq("assigned_to", query.assignedTo) as T;
  if (query.assignedToMe === "true") r = r.eq("assigned_to", scope.userId) as T;
  if (query.customerId) r = r.eq("customer_id", query.customerId) as T;
  if (query.opportunityId) r = r.eq("opportunity_id", query.opportunityId) as T;
  // overdue = not done and due before today (the organization's today): a task due today is not overdue
  if (query.overdue === "true") {
    r = r.neq("status", "done") as T;
    r = r.lt("due_date", scope.today) as T;
  }
  if (query.q) r = r.ilike("title", `%${escapeLike(query.q)}%`) as T;
  return r;
}

/**
 * One page of tasks of the organization, read with the caller's own session so RLS applies (the explicit organization
 * filter is a second line of defence). Parameterized only.
 */
export async function listTasks(
  supabase: Client,
  scope: TaskScope,
  timeZone: string,
  query: TaskListQuery,
): Promise<{ items: TaskDto[]; meta: ReturnType<typeof paginate>["meta"] }> {
  const { from, to } = paginate(query, 0);
  const request = applyFilters(
    supabase.from("tasks").select(TASK_COLUMNS, { count: "exact" }),
    scope,
    query,
  );
  const ascending = query.order === "asc";
  const { data, error, count } = await request
    // no due date sorts last in either direction; the id keeps pages stable
    .order(SORT_COLUMN[query.sort], { ascending, nullsFirst: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) {
    // A page past the end is an empty page, not an error.
    if (error.code === "PGRST103") {
      const { count: total, error: countError } = await applyFilters(
        supabase.from("tasks").select("id", { count: "exact", head: true }),
        scope,
        query,
      );
      if (countError) throw countError;
      return { items: [], meta: paginate(query, total ?? 0).meta };
    }
    throw error;
  }
  const now = new Date();
  return {
    items: ((data ?? []) as unknown as TaskRow[]).map((row) => toTaskDto(row, timeZone, now)),
    meta: paginate(query, count ?? 0).meta,
  };
}

export async function insertTask(
  supabase: Client,
  orgId: string,
  timeZone: string,
  input: CreateTaskInput,
): Promise<TaskDto> {
  const { data, error } = await supabase
    .from("tasks")
    .insert({
      organization_id: orgId,
      title: input.title,
      description: input.description,
      status: input.status,
      priority: input.priority,
      due_date: input.dueDate,
      assigned_to: input.assignedTo,
      customer_id: input.customerId,
      opportunity_id: input.opportunityId,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error) throw error;
  return toTaskDto(data as unknown as TaskRow, timeZone);
}

/** One task of the organization (archived included), or null: missing and cross-tenant look the same. */
export async function findTask(
  supabase: Client,
  orgId: string,
  id: string,
): Promise<TaskRow | null> {
  const { data, error } = await supabase
    .from("tasks")
    .select(TASK_COLUMNS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as TaskRow | null) ?? null;
}

const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The columns the patch would actually change, as `{ column: newValue }`. Empty when the patch is a no-op. */
export function changedColumns(
  current: TaskRow,
  patch: Omit<UpdateTaskInput, "expectedUpdatedAt">,
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
export async function updateTask(
  supabase: Client,
  timeZone: string,
  id: string,
  expectedUpdatedAt: string,
  columns: Record<string, unknown>,
): Promise<TaskDto> {
  const row = await updateIfCurrent(supabase as never, {
    table: "tasks",
    id,
    expected: { updatedAt: expectedUpdatedAt },
    patch: columns,
    columns: TASK_COLUMNS,
  });
  return toTaskDto(row as unknown as TaskRow, timeZone);
}

/** Archive (`archived_at = now()`). Idempotent: an already archived row is left alone. */
export async function archiveTask(supabase: Client, orgId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from("tasks")
    .update({ archived_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("archived_at", null);
  if (error) throw error;
}
