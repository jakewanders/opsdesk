import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan } from "@/lib/permissions";
import type { OrgContext } from "@/lib/api/org-context";
import type { Database } from "@/lib/supabase/database.types";
import { NotFoundError } from "@/lib/api/errors";
import { StaleEditError } from "@/lib/api/concurrency";
import {
  changedColumns,
  countRelated,
  findCustomer,
  findOtherCustomerWithEmail,
  insertCustomer,
  listCustomers,
  setArchived,
  updateCustomer,
} from "./repository";
import {
  toCustomerDto,
  type CreateCustomerInput,
  type CustomerDetailDto,
  type CustomerDto,
  type CustomerListQuery,
  type UpdateCustomerInput,
} from "./schema";

type Client = SupabaseClient<Database>;

export type ApiWarning = { code: string; field?: string; message: string; customerId?: string };

/** Everyone who can read the workspace can list its customers (the permission module still decides). */
export async function listForOrg(supabase: Client, ctx: OrgContext, query: CustomerListQuery) {
  assertCan(ctx.role, ctx.kind, "records.read");
  return listCustomers(supabase, ctx.org.id, query);
}

/**
 * Creates a customer. Owner, admin and member may (viewers get 403 from the permission module, and the database
 * refuses them too). A duplicate e-mail is a warning in the response, never a failure: two people can share an address.
 */
export async function createForOrg(
  supabase: Client,
  ctx: OrgContext,
  input: CreateCustomerInput,
): Promise<{ customer: CustomerDto; warnings: ApiWarning[] }> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const customer = await insertCustomer(supabase, ctx.org.id, input);
  const warnings: ApiWarning[] = [];
  if (customer.email) {
    const other = await findOtherCustomerWithEmail(
      supabase,
      ctx.org.id,
      customer.email,
      customer.id,
    );
    if (other) {
      warnings.push({
        code: "DUPLICATE_EMAIL",
        field: "email",
        message: `Another customer in this workspace already uses this email address (${other.displayName}).`,
        customerId: other.id,
      });
    }
  }
  return { customer, warnings };
}

const notFound = () => new NotFoundError("That customer was not found.", "CUSTOMER_NOT_FOUND");

async function duplicateWarnings(
  supabase: Client,
  ctx: OrgContext,
  customer: CustomerDto,
): Promise<ApiWarning[]> {
  if (!customer.email) return [];
  const other = await findOtherCustomerWithEmail(supabase, ctx.org.id, customer.email, customer.id);
  return other
    ? [
        {
          code: "DUPLICATE_EMAIL",
          field: "email",
          message: `Another customer in this workspace already uses this email address (${other.displayName}).`,
          customerId: other.id,
        },
      ]
    : [];
}

/** One customer with the counts of its related records. A missing id and another tenant's id are both 404. */
export async function getForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
): Promise<CustomerDetailDto> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const row = await findCustomer(supabase, ctx.org.id, id);
  if (!row) throw notFound();
  return { ...toCustomerDto(row), related: await countRelated(supabase, ctx.org.id, id) };
}

/**
 * Partial update with optimistic concurrency. The client sends the `updatedAt` it last saw; a mismatch is a 409
 * `STALE_EDIT` with the current version and nothing is overwritten. A patch that would change nothing is a 200 that
 * writes nothing (so no activity event and no new `updatedAt`). Activity events come from the database trigger.
 */
export async function updateForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: UpdateCustomerInput,
): Promise<{ customer: CustomerDto; warnings: ApiWarning[] }> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const { expectedUpdatedAt, ...patch } = input;
  const current = await findCustomer(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  if (current.updated_at !== expectedUpdatedAt)
    throw new StaleEditError({ updatedAt: current.updated_at });

  const columns = changedColumns(current, patch);
  if (Object.keys(columns).length === 0) return { customer: toCustomerDto(current), warnings: [] };

  const customer = await updateCustomer(supabase, id, expectedUpdatedAt, columns);
  return {
    customer,
    warnings: "email" in columns ? await duplicateWarnings(supabase, ctx, customer) : [],
  };
}

/** Soft delete. Idempotent: archiving an archived customer is still a success. */
export async function archiveForOrg(supabase: Client, ctx: OrgContext, id: string): Promise<void> {
  assertCan(ctx.role, ctx.kind, "records.write");
  if (!(await findCustomer(supabase, ctx.org.id, id))) throw notFound();
  await setArchived(supabase, ctx.org.id, id, true);
}

/** Clears `archived_at`. Idempotent: restoring an active customer returns it unchanged. */
export async function restoreForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
): Promise<CustomerDto> {
  assertCan(ctx.role, ctx.kind, "records.write");
  const current = await findCustomer(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  return (await setArchived(supabase, ctx.org.id, id, false)) ?? toCustomerDto(current);
}
