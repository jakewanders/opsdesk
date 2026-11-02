import type { SupabaseClient } from "@supabase/supabase-js";
import { ConflictError, NotFoundError } from "@/lib/api/errors";
import { StaleEditError } from "@/lib/api/concurrency";
import { mapPostgresError } from "@/lib/api/postgres-errors";
import type { OrgContext } from "@/lib/api/org-context";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import {
  findItems,
  findQuote,
  findRevised,
  findRevisions,
  findStatusHistory,
  listQuotes,
  rpcCreate,
  rpcRevise,
  rpcTransition,
  rpcUpdate,
} from "./repository";
import {
  toQuoteDto,
  type CreateQuoteInput,
  type QuoteDetailDto,
  type QuoteListQuery,
  type TransitionQuoteInput,
  type UpdateQuoteInput,
} from "./schema";

type Client = SupabaseClient<Database>;

const notFound = () => new NotFoundError("That quote was not found.", "QUOTE_NOT_FOUND");

/** Everyone who can read the workspace can list its quotes. */
export async function listForOrg(supabase: Client, ctx: OrgContext, query: QuoteListQuery) {
  assertCan(ctx.role, ctx.kind, "records.read");
  return listQuotes(supabase, ctx.org.id, query);
}

/** The quote with its lines, the quote it revises, the revisions made from it and its status history. */
export async function getForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
): Promise<QuoteDetailDto> {
  assertCan(ctx.role, ctx.kind, "records.read");
  const row = await findQuote(supabase, ctx.org.id, id);
  if (!row) throw notFound();
  const [items, revisions, revises, statusHistory] = await Promise.all([
    findItems(supabase, id),
    findRevisions(supabase, ctx.org.id, id),
    row.revises_quote_id ? findRevised(supabase, ctx.org.id, row.revises_quote_id) : null,
    findStatusHistory(supabase, ctx.org.id, id),
  ]);
  return { ...toQuoteDto(row), items, revises, revisions, statusHistory };
}

/**
 * A stale version from the database becomes the standard 409 with the current version in `error.meta.current`, so the client can
 * reload and offer to try again.
 */
async function withStaleMeta<T>(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  run: () => Promise<T>,
) {
  try {
    return await run();
  } catch (error) {
    const mapped = mapPostgresError(error);
    if (mapped instanceof ConflictError && mapped.code === "STALE_EDIT") {
      const current = await findQuote(supabase, ctx.org.id, id);
      if (current)
        throw new StaleEditError({ updatedAt: current.updated_at, version: current.version });
    }
    throw error;
  }
}

/** Creates a draft (owner, admin, member; a demo guest too). Totals and the number come from the database. */
export async function createForOrg(
  supabase: Client,
  ctx: OrgContext,
  input: CreateQuoteInput,
): Promise<QuoteDetailDto> {
  assertCan(ctx.role, ctx.kind, "quotes.write");
  const row = await rpcCreate(supabase, ctx.org.id, input);
  return getForOrg(supabase, ctx, row.id);
}

/**
 * Edits a draft: the fields sent replace the current ones, the lines (when sent) replace all lines, at the version the client saw.
 * A quote that has been sent is 409 `QUOTE_LOCKED`; a stale version is 409 `STALE_EDIT`; nothing is written in either case.
 */
export async function updateForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: UpdateQuoteInput,
): Promise<QuoteDetailDto> {
  assertCan(ctx.role, ctx.kind, "quotes.write");
  const current = await findQuote(supabase, ctx.org.id, id);
  if (!current) throw notFound();
  if (current.status !== "draft") {
    throw new ConflictError(
      "A quote that has been sent cannot be edited. Revise it to make a new draft.",
      "QUOTE_LOCKED",
    );
  }
  const items = input.items ?? (await findItems(supabase, id));
  await withStaleMeta(supabase, ctx, id, () =>
    rpcUpdate(supabase, id, input.expectedVersion, {
      customerId: input.customerId ?? current.customer_id,
      opportunityId:
        input.opportunityId === undefined ? current.opportunity_id : input.opportunityId,
      title: input.title ?? current.title,
      issueDate: input.issueDate ?? current.issue_date,
      validUntil: input.validUntil === undefined ? current.valid_until : input.validUntil,
      taxRateBps: input.taxRateBps ?? Number(current.tax_rate_bps),
      discountCents: input.discountCents ?? Number(current.discount_cents),
      notes: input.notes === undefined ? current.notes : input.notes,
      items: items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
      })),
    }),
  );
  return getForOrg(supabase, ctx, id);
}

/** Moves a quote along draft -> sent -> approved | rejected | expired. Anything else is 409 `QUOTE_STATUS_TRANSITION`. */
export async function transitionForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
  input: TransitionQuoteInput,
): Promise<QuoteDetailDto> {
  assertCan(ctx.role, ctx.kind, "quotes.write");
  const version =
    input.expectedVersion ?? (await findQuote(supabase, ctx.org.id, id))?.version ?? null;
  if (version === null) throw notFound();
  await withStaleMeta(supabase, ctx, id, () =>
    rpcTransition(supabase, id, Number(version), input.to),
  );
  return getForOrg(supabase, ctx, id);
}

/** Starts a new draft from a sent (or later) quote; the original is untouched. */
export async function reviseForOrg(
  supabase: Client,
  ctx: OrgContext,
  id: string,
): Promise<QuoteDetailDto> {
  assertCan(ctx.role, ctx.kind, "quotes.write");
  const row = await rpcRevise(supabase, id);
  return getForOrg(supabase, ctx, row.id);
}
