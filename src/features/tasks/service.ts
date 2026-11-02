import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleEditError } from "@/lib/api/concurrency";
import { NotFoundError } from "@/lib/api/errors";
import type { OrgContext } from "@/lib/api/org-context";
import { todayInZone } from "@/lib/domain/tasks";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import { findCustomer } from "@/features/customers/repository";
import { findOpportunity } from "@/features/opportunities/repository";
import {
  archiveTask,
  changedColumns,
  findTask,
  insertTask,
  listTasks,
  updateTask,
} from "./repository";
import {
  toTaskDto,
  type CompleteTaskInput,
  type CreateTaskInput,
  type TaskDto,
  type TaskListQuery,
  type UpdateTaskInput,
} from "./schema";

type Client = SupabaseClient<Database>;

const notFound = () => new NotFoundError("That task was not found.", "TASK_NOT_FOUND");

/** A linked customer or deal must be one this caller can see in this workspace; another tenant's is a 404 too. */
async function assertLinksVisible(
  supabase: Client,
  ctx: OrgContext,
  links: { customerId?: string | null; opportunityId?: string | null },
) {
  if (links.customerId && !(await findCustomer(supabase, ctx.org.id, links.customerId)))
    throw new NotFoundError("That customer was not found.", "CUSTOMER_NOT_FOUND");
  if (links.opportunityId && !(await findOpportunity(supabase, ctx.org.id, links.opportunityId)))
    throw new NotFoundError("That opportunity was not found.", "OPPORTUNITY_NOT_FOUND");
}

/** Everyone who can read the workspace can list its tasks. "Today" is the date in the organization's time zone. */
export async function listForOrg(supabase: Client, ctx: OrgContext, query: TaskListQuery) {
  assertCan(ctx.role, ctx.kind, "records.read");
  const today = todayInZone(new Date(), ctx.org.timezone);
  return listTasks(
    supabase,
    { orgId: ctx.org.id, userId: ctx.user.id, today },
    ctx.org.timezone,
    query,
  );
}

/** Creates a task (owner, admin, member). Linked records are checked first (404, nothing written); the assignee by the database (422). */
export async function createForOrg(
  supabase: Client,
  ctx: OrgContext,
  input: CreateTaskInput,
): Promise<TaskDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  await assertLinksVisible(supabase, ctx, input);
  return insertTask(supabase, ctx.org.id, ctx.org.timezone, input);
}

export async function getForOrg(supabase: Client, ctx: OrgContext, id: string): Promise<TaskDto> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const row = await findTask(supabase, ctx.org.id, id);
  if (!row) throw notFound();
  return toTaskDto(row, ctx.org.timezone);
}

/**
 * Partial update with optimistic concurrency (a stale `updatedAt` is 409 `STALE_EDIT`, nothing is overwritten). A patch
 * that would change nothing is a 200 that writes nothing. Activity events (including completed / reopened when the status
 * crosses done) come from the database triggers.
 */
export async function updateForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: UpdateTaskInput,
): Promise<TaskDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const { expectedUpdatedAt, ...patch } = input;
  const current = await findTask(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  if (current.updated_at !== expectedUpdatedAt)
    throw new StaleEditError({ updatedAt: current.updated_at });

  const columns = changedColumns(current, patch);
  if (Object.keys(columns).length === 0) return toTaskDto(current, ctx.org.timezone);
  await assertLinksVisible(supabase, ctx, {
    customerId: "customer_id" in columns ? (columns.customer_id as string | null) : null,
    opportunityId: "opportunity_id" in columns ? (columns.opportunity_id as string | null) : null,
  });
  return updateTask(supabase, ctx.org.timezone, id, expectedUpdatedAt, columns);
}

/**
 * Completes (`completed: true`) or reopens (`false`, back to `todo` unless `status` says otherwise) a task. Asking for the
 * state the task is already in is a 200 that writes nothing, so a repeated call adds no event. The database stamps and
 * clears `completed_at` and writes the `completed` / `reopened` event.
 */
export async function completeForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: CompleteTaskInput,
): Promise<TaskDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const current = await findTask(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  if (current.updated_at !== input.expectedUpdatedAt)
    throw new StaleEditError({ updatedAt: current.updated_at });

  const isDone = current.status === "done";
  if (input.completed === isDone) return toTaskDto(current, ctx.org.timezone);
  const status = input.completed ? "done" : (input.status ?? "todo");
  return updateTask(supabase, ctx.org.timezone, id, input.expectedUpdatedAt, { status });
}

/** Soft delete. Idempotent: archiving an archived task is still a success. */
export async function archiveForOrg(supabase: Client, ctx: OrgContext, id: string): Promise<void> {
  assertCan(ctx.role, ctx.kind, "records.write");
  if (!(await findTask(supabase, ctx.org.id, id))) throw notFound();
  await archiveTask(supabase, ctx.org.id, id);
}
