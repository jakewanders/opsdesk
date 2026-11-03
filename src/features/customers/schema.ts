import { z } from "zod";
import { expectedUpdatedAtField } from "@/lib/api/concurrency";
import {
  choice,
  isoDate,
  listQuery,
  optionalMultiLine,
  optionalSingleLine,
  singleLine,
  tagFilter,
  tags,
  url,
  uuid,
  email as emailSchema,
} from "@/lib/validation";

/** The enums mirror the database CHECK constraints (customers_*_values). */
export const CUSTOMER_TYPES = ["person", "company"] as const;
export const CUSTOMER_STATUSES = ["lead", "active", "inactive"] as const;
export const CUSTOMER_SOURCES = ["referral", "website", "outbound", "other"] as const;

/** Blank or missing becomes null; otherwise the inner schema decides. */
const optional = <T extends z.ZodType<unknown, string>>(schema: T) =>
  z
    .union([z.null(), z.undefined(), z.string()])
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), schema]));

const optionalEmail = () => optional(emailSchema());
// The database column holds 255 characters; refuse longer at the edge with a clear message.
const optionalWebsite = () =>
  optional(url().refine((v) => v.length <= 255, "Use 255 characters or fewer."));

/**
 * Body of POST /api/v1/customers (US-03). Unknown fields are rejected, so an `organizationId`, `createdBy` or
 * `id` can never be injected. Text is plain text: HTML-looking input is a 422.
 */
export const createCustomerSchema = z.strictObject({
  type: choice(CUSTOMER_TYPES).default("person"),
  displayName: singleLine(120, 2),
  companyName: optionalSingleLine(120).default(null),
  email: optionalEmail().default(null),
  phone: optionalSingleLine(40).default(null),
  website: optionalWebsite().default(null),
  status: choice(CUSTOMER_STATUSES).default("lead"),
  source: choice(CUSTOMER_SOURCES).default("other"),
  tags: tags().default([]),
  notes: optionalMultiLine(5000).default(null),
  assignedTo: optional(uuid()).default(null),
});
export type CreateCustomerInput = z.output<typeof createCustomerSchema>;

/**
 * Body of PATCH /api/v1/customers/:id: the same field rules as create, every field optional (absent = unchanged,
 * null or blank = cleared where the field is optional), plus the `updatedAt` the client last saw. Unknown fields are
 * refused, so `organizationId`, `createdBy` and `id` can never be changed.
 */
export const updateCustomerSchema = z.strictObject({
  ...expectedUpdatedAtField,
  type: choice(CUSTOMER_TYPES).optional(),
  displayName: singleLine(120, 2).optional(),
  companyName: optionalSingleLine(120).optional(),
  email: optionalEmail().optional(),
  phone: optionalSingleLine(40).optional(),
  website: optionalWebsite().optional(),
  status: choice(CUSTOMER_STATUSES).optional(),
  source: choice(CUSTOMER_SOURCES).optional(),
  tags: tags().optional(),
  notes: optionalMultiLine(5000).optional(),
  assignedTo: optional(uuid()).optional(),
});
export type UpdateCustomerInput = z.output<typeof updateCustomerSchema>;

/** The patch fields (everything but the version) mapped to column names. */
export const PATCH_COLUMNS = {
  type: "type",
  displayName: "display_name",
  companyName: "company_name",
  email: "email",
  phone: "phone",
  website: "website",
  status: "status",
  source: "source",
  tags: "tags",
  notes: "notes",
  assignedTo: "assigned_to",
} as const;

/** A customer with the counts of what hangs off it (entities that do not exist yet count as zero). */
export type CustomerDetailDto = CustomerDto & {
  /** `openOpportunities` and `openTasks` count what is still active (not won/lost/done, not archived); the archive warning uses them. */
  related: {
    opportunities: number;
    tasks: number;
    quotes: number;
    openOpportunities: number;
    openTasks: number;
  };
};

export const CUSTOMER_SORTS = ["updated_at", "created_at", "display_name", "status"] as const;

/** Query of GET /api/v1/customers. */
export const customerListQuery = listQuery({
  sortable: CUSTOMER_SORTS,
  defaultSort: "updated_at",
  defaultOrder: "desc",
  ranges: [
    ["createdFrom", "createdTo"],
    ["updatedFrom", "updatedTo"],
  ],
  filters: {
    /** Has ALL of these tags: one to five, separated by commas, exact text as stored. */
    tags: tagFilter().optional(),
    /** Created / last changed between these days, both included, in the workspace's time zone. */
    createdFrom: isoDate().optional(),
    createdTo: isoDate().optional(),
    updatedFrom: isoDate().optional(),
    updatedTo: isoDate().optional(),
    /** Search text over name, company and e-mail (partial, case-insensitive). */
    q: singleLine(100).optional(),
    status: choice(CUSTOMER_STATUSES).optional(),
    source: choice(CUSTOMER_SOURCES).optional(),
    assignedTo: uuid().optional(),
    /** `false` (default): active only; `true`: archived only; `all`: both. */
    archived: z
      .enum(["false", "true", "all"], { error: "Use false, true or all." })
      .default("false"),
  },
});
export type CustomerListQuery = z.output<typeof customerListQuery>;

/** A customer as the API returns it (camelCase; the search column and organization id are internal). */
export type CustomerDto = {
  id: string;
  type: (typeof CUSTOMER_TYPES)[number];
  displayName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  status: (typeof CUSTOMER_STATUSES)[number];
  source: (typeof CUSTOMER_SOURCES)[number];
  tags: string[];
  notes: string | null;
  assignedTo: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CustomerRow = {
  id: string;
  type: string;
  display_name: string;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  status: string;
  source: string;
  tags: string[];
  notes: string | null;
  assigned_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export function toCustomerDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id,
    type: row.type as CustomerDto["type"],
    displayName: row.display_name,
    companyName: row.company_name,
    email: row.email,
    phone: row.phone,
    website: row.website,
    status: row.status as CustomerDto["status"],
    source: row.source as CustomerDto["source"],
    tags: row.tags,
    notes: row.notes,
    assignedTo: row.assigned_to,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/** The columns the API selects (never `search_text` or `organization_id`). */
export const CUSTOMER_COLUMNS =
  "id, type, display_name, company_name, email, phone, website, status, source, tags, notes, assigned_to, created_by, created_at, updated_at, archived_at";
