import type { SupabaseClient } from "@supabase/supabase-js";
import { assertCan } from "@/lib/permissions";
import type { OrgContext } from "@/lib/api/org-context";
import type { Database } from "@/lib/supabase/database.types";
import { findOtherCustomerWithEmail, insertCustomer, listCustomers } from "./repository";
import type { CreateCustomerInput, CustomerDto, CustomerListQuery } from "./schema";

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
