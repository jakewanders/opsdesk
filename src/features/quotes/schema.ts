import { z } from "zod";
import { choice, isoDate, listQuery, optionalMultiLine, singleLine, uuid } from "@/lib/validation";
import {
  QUANTITY_MAX,
  TAX_RATE_MAX_BPS,
  UNIT_PRICE_MAX_CENTS,
  type QuoteLineInput,
} from "@/lib/domain/quotes";

/** The limits are the calculation module's and the database's (SIT-174, SIT-222, SIT-230); the database checks them again. */
export const QUOTE_STATUSES = ["draft", "sent", "approved", "rejected", "expired"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const TRANSITION_TARGETS = ["sent", "approved", "rejected", "expired"] as const;
export const MAX_QUOTE_ITEMS = 100;

export const quoteItemSchema = z.strictObject({
  description: singleLine(300, 2),
  quantity: z
    .number({ error: "Enter a whole quantity." })
    .int("Enter a whole quantity.")
    .min(1, "The quantity must be at least 1.")
    .max(QUANTITY_MAX, `The quantity can be at most ${QUANTITY_MAX.toLocaleString("en-US")}.`),
  unitPriceCents: z
    .number({ error: "Enter the price in whole cents." })
    .int("Enter the price in whole cents.")
    .min(0, "The price cannot be negative.")
    .max(UNIT_PRICE_MAX_CENTS, "That price is too large."),
});
export type QuoteItemInput = z.output<typeof quoteItemSchema>;

const items = z
  .array(quoteItemSchema, { error: "Send the line items as a list." })
  .min(1, "Add at least one line item.")
  .max(MAX_QUOTE_ITEMS, `A quote can have at most ${MAX_QUOTE_ITEMS} line items.`);

const taxRateBps = z
  .number({ error: "Enter the tax rate in basis points." })
  .int("Enter the tax rate in whole basis points (825 is 8.25%).")
  .min(0, "The tax rate cannot be negative.")
  .max(TAX_RATE_MAX_BPS, "The tax rate cannot be more than 100%.");
const discountCents = z
  .number({ error: "Enter the discount in whole cents." })
  .int("Enter the discount in whole cents.")
  .min(0, "The discount cannot be negative.")
  .max(Number.MAX_SAFE_INTEGER, "That discount is too large.");

/**
 * Body of POST /api/v1/quotes. Unknown fields are refused, so a `totalCents`, `subtotalCents`, `quoteNumber` or `status` sent by a
 * client is a 422, never trusted and never silently dropped: the server computes every total and allocates the number.
 */
export const createQuoteSchema = z.strictObject({
  customerId: uuid(),
  opportunityId: uuid().nullish().default(null),
  title: singleLine(150, 2),
  issueDate: isoDate().nullish().default(null),
  validUntil: isoDate().nullish().default(null),
  taxRateBps: taxRateBps.default(0),
  discountCents: discountCents.default(0),
  notes: optionalMultiLine(5000).default(null),
  items,
});
export type CreateQuoteInput = z.output<typeof createQuoteSchema>;

/** Body of PATCH /api/v1/quotes/:id (a draft): any of the fields above, plus the `version` the client last saw. */
export const updateQuoteSchema = z.strictObject({
  expectedVersion: z
    .number({ error: "Reload the quote and try again." })
    .int("Reload the quote and try again.")
    .min(1, "Reload the quote and try again."),
  customerId: uuid().optional(),
  opportunityId: uuid().nullable().optional(),
  title: singleLine(150, 2).optional(),
  issueDate: isoDate().optional(),
  validUntil: isoDate().nullable().optional(),
  taxRateBps: taxRateBps.optional(),
  discountCents: discountCents.optional(),
  notes: optionalMultiLine(5000).optional(),
  items: items.optional(),
});
export type UpdateQuoteInput = z.output<typeof updateQuoteSchema>;

/** Body of POST /api/v1/quotes/:id/transition. `expectedVersion` is optional here: without it the server uses the quote's current version. */
export const transitionQuoteSchema = z.strictObject({
  to: choice(TRANSITION_TARGETS),
  expectedVersion: z.number().int().min(1).optional(),
});
export type TransitionQuoteInput = z.output<typeof transitionQuoteSchema>;

export const QUOTE_SORTS = [
  "updated_at",
  "created_at",
  "quote_number",
  "title",
  "total_cents",
  "issue_date",
  "status",
] as const;

/** Query of GET /api/v1/quotes. */
export const quoteListQuery = listQuery({
  sortable: QUOTE_SORTS,
  defaultSort: "updated_at",
  defaultOrder: "desc",
  ranges: [
    ["issueFrom", "issueTo"],
    ["validFrom", "validTo"],
  ],
  filters: {
    /** Valid-until date range, both ends included. Quotes with no end date never match. */
    validFrom: isoDate().optional(),
    validTo: isoDate().optional(),
    /** Search text over the quote number and title (partial, case-insensitive). */
    q: singleLine(100).optional(),
    status: choice(QUOTE_STATUSES).optional(),
    customerId: uuid().optional(),
    opportunityId: uuid().optional(),
    /** Issue date range, both ends included. */
    issueFrom: isoDate().optional(),
    issueTo: isoDate().optional(),
    /** `false` (default): active only; `true`: archived only; `all`: both. */
    archived: z
      .enum(["false", "true", "all"], { error: "Use false, true or all." })
      .default("false"),
  },
});
export type QuoteListQuery = z.output<typeof quoteListQuery>;

export type QuoteItemDto = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** quantity x unit price, computed here for display only: the stored total is the database's. */
  lineTotalCents: number;
};

export type QuoteDto = {
  id: string;
  quoteNumber: string;
  customerId: string;
  customerName: string | null;
  opportunityId: string | null;
  title: string;
  currency: "USD";
  status: QuoteStatus;
  issueDate: string;
  validUntil: string | null;
  taxRateBps: number;
  discountCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  notes: string | null;
  version: number;
  revisesQuoteId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type QuoteDetailDto = QuoteDto & {
  items: QuoteItemDto[];
  /** The quote this one revises, and the revisions made from it (the chain, one step each way). */
  revises: { id: string; quoteNumber: string; status: QuoteStatus } | null;
  revisions: Array<{ id: string; quoteNumber: string; status: QuoteStatus; createdAt: string }>;
  /** Where the quote has been: draft at creation, then each status change, from the activity record. */
  statusHistory: Array<{ status: QuoteStatus; at: string }>;
};

export type QuoteRow = {
  id: string;
  quote_number: string;
  customer_id: string;
  opportunity_id: string | null;
  title: string;
  currency: string;
  status: string;
  issue_date: string;
  valid_until: string | null;
  tax_rate_bps: number;
  discount_cents: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  notes: string | null;
  version: number;
  revises_quote_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  customer?: { display_name: string } | null;
};

export function toQuoteDto(row: QuoteRow): QuoteDto {
  return {
    id: row.id,
    quoteNumber: row.quote_number,
    customerId: row.customer_id,
    customerName: row.customer?.display_name ?? null,
    opportunityId: row.opportunity_id,
    title: row.title,
    currency: "USD",
    status: row.status as QuoteStatus,
    issueDate: row.issue_date,
    validUntil: row.valid_until,
    taxRateBps: Number(row.tax_rate_bps),
    discountCents: Number(row.discount_cents),
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    notes: row.notes,
    version: Number(row.version),
    revisesQuoteId: row.revises_quote_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export const QUOTE_COLUMNS =
  "id, quote_number, customer_id, opportunity_id, title, currency, status, issue_date, valid_until, tax_rate_bps, discount_cents, subtotal_cents, tax_cents, total_cents, notes, version, revises_quote_id, created_by, created_at, updated_at, archived_at, customer:customers!quotes_customer_fkey(display_name)";

/** For the editor's items: the shape the functions take. */
export const toLineInputs = (
  rows: QuoteItemDto[],
): Array<QuoteLineInput & { description: string }> =>
  rows.map((r) => ({
    description: r.description,
    quantity: r.quantity,
    unitPriceCents: r.unitPriceCents,
  }));
