import { z } from "zod";
import { expectedUpdatedAtField } from "@/lib/api/concurrency";
import { LOST_REASON_MAX, OPEN_STAGES, STAGES, type Stage } from "@/lib/domain/pipeline";
import {
  cents,
  choice,
  isoDate,
  listQuery,
  multiLine,
  optionalMultiLine,
  singleLine,
  uuid,
} from "@/lib/validation";

/** Blank or missing becomes null; otherwise the inner schema decides. */
const optional = <T extends z.ZodType<unknown, string>>(schema: T) =>
  z
    .union([z.null(), z.undefined(), z.string()])
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), schema]));

const probability = () =>
  z
    .number({ error: "Enter a whole percent from 0 to 100." })
    .int("Enter a whole percent from 0 to 100.")
    .min(0, "Enter a whole percent from 0 to 100.")
    .max(100, "Enter a whole percent from 0 to 100.");

/**
 * Body of POST /api/v1/opportunities (US-04). A deal starts in an OPEN stage (default `new`): won and lost carry a
 * closing time and a lost reason, which only the stage endpoint sets, so those rules live in one place. When
 * `probabilityPercent` is left out the database applies the stage's default.
 */
export const createOpportunitySchema = z.strictObject({
  customerId: uuid(),
  title: singleLine(150, 2),
  description: optionalMultiLine(5000).default(null),
  stage: choice(OPEN_STAGES).default("new"),
  amountCents: cents().default(0),
  probabilityPercent: probability().optional(),
  expectedCloseDate: optional(isoDate()).default(null),
  assignedTo: optional(uuid()).default(null),
});
export type CreateOpportunityInput = z.output<typeof createOpportunitySchema>;

const STAGE_VIA_ENDPOINT =
  "Change the stage with POST /api/v1/opportunities/{id}/stage, not by editing the deal.";

/**
 * Body of PATCH /api/v1/opportunities/:id: every field optional, plus the `updatedAt` the client last saw. `stage` is
 * named so it can be refused with a clear message instead of the generic "unknown field".
 */
export const updateOpportunitySchema = z.strictObject({
  ...expectedUpdatedAtField,
  customerId: uuid().optional(),
  title: singleLine(150, 2).optional(),
  description: optionalMultiLine(5000).optional(),
  stage: z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value !== undefined) ctx.addIssue({ code: "custom", message: STAGE_VIA_ENDPOINT });
    }),
  amountCents: cents().optional(),
  probabilityPercent: probability().optional(),
  expectedCloseDate: optional(isoDate()).optional(),
  assignedTo: optional(uuid()).optional(),
});
export type UpdateOpportunityInput = z.output<typeof updateOpportunitySchema>;

/** The patch fields (everything but the version and the refused stage) mapped to column names. */
export const PATCH_COLUMNS = {
  customerId: "customer_id",
  title: "title",
  description: "description",
  amountCents: "amount_cents",
  probabilityPercent: "probability_percent",
  expectedCloseDate: "expected_close_date",
  assignedTo: "assigned_to",
} as const;

/**
 * Body of POST /api/v1/opportunities/:id/stage: the stage to move to, the lost reason (required for `lost`, ignored
 * otherwise) and the `updatedAt` the client last saw. The lost reason rules are enforced again by the database function.
 */
export const moveStageSchema = z.strictObject({
  ...expectedUpdatedAtField,
  stage: choice(STAGES),
  lostReason: optional(multiLine(LOST_REASON_MAX)).default(null),
});
export type MoveStageInput = z.output<typeof moveStageSchema>;

export const OPPORTUNITY_SORTS = [
  "updated_at",
  "created_at",
  "title",
  "amount_cents",
  "expected_close_date",
  "stage",
] as const;

/** Query of GET /api/v1/opportunities. */
export const opportunityListQuery = listQuery({
  sortable: OPPORTUNITY_SORTS,
  defaultSort: "updated_at",
  defaultOrder: "desc",
  filters: {
    /** Search text over the deal title and its customer's name (partial, case-insensitive). */
    q: singleLine(100).optional(),
    stage: choice(STAGES).optional(),
    assignedTo: uuid().optional(),
    customerId: uuid().optional(),
    /** Expected close date range, both ends included. */
    closeFrom: isoDate().optional(),
    closeTo: isoDate().optional(),
    /** `false` (default): active only; `true`: archived only; `all`: both. */
    archived: z
      .enum(["false", "true", "all"], { error: "Use false, true or all." })
      .default("false"),
  },
});
export type OpportunityListQuery = z.output<typeof opportunityListQuery>;

export type OpportunityDto = {
  id: string;
  customerId: string;
  customerName: string | null;
  title: string;
  description: string | null;
  stage: Stage;
  amountCents: number;
  probabilityPercent: number;
  expectedCloseDate: string | null;
  assignedTo: string | null;
  lostReason: string | null;
  closedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type OpportunityRow = {
  id: string;
  customer_id: string;
  title: string;
  description: string | null;
  stage: string;
  amount_cents: number;
  probability_percent: number | null;
  expected_close_date: string | null;
  assigned_to: string | null;
  lost_reason: string | null;
  closed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  customer?: { display_name: string } | null;
};

export function toOpportunityDto(row: OpportunityRow): OpportunityDto {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: row.customer?.display_name ?? null,
    title: row.title,
    description: row.description,
    stage: row.stage as Stage,
    amountCents: Number(row.amount_cents),
    probabilityPercent: Number(row.probability_percent ?? 0),
    expectedCloseDate: row.expected_close_date,
    assignedTo: row.assigned_to,
    lostReason: row.lost_reason,
    closedAt: row.closed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/** The columns the API selects, with the customer's name. */
export const OPPORTUNITY_COLUMNS =
  "id, customer_id, title, description, stage, amount_cents, probability_percent, expected_close_date, assigned_to, lost_reason, closed_at, created_by, created_at, updated_at, archived_at, customer:customers!opportunities_customer_fkey(display_name)";
