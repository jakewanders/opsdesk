import type { SupabaseClient } from "@supabase/supabase-js";
import { StaleEditError } from "@/lib/api/concurrency";
import { NotFoundError } from "@/lib/api/errors";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import { findCustomer } from "@/features/customers/repository";
import {
  archiveOpportunity,
  changedColumns,
  findOpportunity,
  insertOpportunity,
  listOpportunities,
  updateOpportunity,
} from "./repository";
import {
  toOpportunityDto,
  type CreateOpportunityInput,
  type OpportunityDto,
  type OpportunityListQuery,
  type UpdateOpportunityInput,
} from "./schema";

type Client = SupabaseClient<Database>;

const notFound = () =>
  new NotFoundError("That opportunity was not found.", "OPPORTUNITY_NOT_FOUND");
const customerNotFound = () =>
  new NotFoundError("That customer was not found.", "CUSTOMER_NOT_FOUND");

/** The customer must be one this caller can see in this workspace; another tenant's is the same 404 as a missing one. */
async function assertCustomerVisible(supabase: Client, ctx: OrgContext, customerId: string) {
  if (!(await findCustomer(supabase, ctx.org.id, customerId))) throw customerNotFound();
}

/** Everyone who can read the workspace can list its opportunities. */
export async function listForOrg(supabase: Client, ctx: OrgContext, query: OpportunityListQuery) {
  assertCan(ctx.role, ctx.kind, "records.read");
  return listOpportunities(supabase, ctx.org.id, query);
}

/**
 * Creates an opportunity (owner, admin, member). The customer is checked first (404 when it is not in this workspace,
 * and nothing is written); the assignee is checked by the database's composite key (422).
 */
export async function createForOrg(
  supabase: Client,
  ctx: OrgContext,
  input: CreateOpportunityInput,
): Promise<OpportunityDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  await assertCustomerVisible(supabase, ctx, input.customerId);
  return insertOpportunity(supabase, ctx.org.id, input);
}

export async function getForOrg(supabase: Client, ctx: OrgContext, id: string) {
  assertCan(ctx.role, ctx.kind, "records.read");
  const row = await findOpportunity(supabase, ctx.org.id, id);
  if (!row) throw notFound();
  return toOpportunityDto(row);
}

/**
 * Partial update with optimistic concurrency (a stale `updatedAt` is 409 `STALE_EDIT`, nothing is overwritten). A patch
 * that would change nothing is a 200 that writes nothing. `stage` never reaches here (the schema refuses it).
 */
export async function updateForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: UpdateOpportunityInput,
): Promise<OpportunityDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const { expectedUpdatedAt, stage: _stage, ...patch } = input;
  void _stage;
  const current = await findOpportunity(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  if (current.updated_at !== expectedUpdatedAt)
    throw new StaleEditError({ updatedAt: current.updated_at });

  const columns = changedColumns(current, patch);
  if (Object.keys(columns).length === 0) return toOpportunityDto(current);
  if (patch.customerId && patch.customerId !== current.customer_id)
    await assertCustomerVisible(supabase, ctx, patch.customerId);

  return updateOpportunity(supabase, id, expectedUpdatedAt, columns);
}

/** Soft delete. Idempotent: archiving an archived opportunity is still a success. */
export async function archiveForOrg(supabase: Client, ctx: OrgContext, id: string): Promise<void> {
  assertCan(ctx.role, ctx.kind, "records.write");
  if (!(await findOpportunity(supabase, ctx.org.id, id))) throw notFound();
  await archiveOpportunity(supabase, ctx.org.id, id);
}
