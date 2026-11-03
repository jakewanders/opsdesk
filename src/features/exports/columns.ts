import type { CustomerDto } from "@/features/customers/schema";
import type { OpportunityDto } from "@/features/opportunities/schema";
import type { TaskDto } from "@/features/tasks/schema";
import type { CsvValue } from "@/lib/csv/write";

/**
 * The export's columns: a stable order and fixed header names (snake_case, the database's own words). Adding a column goes at the end
 * of an entity's list so existing spreadsheets keep working. Money is whole cents (`amount_cents`), dates are ISO 8601 (calendar dates
 * as `YYYY-MM-DD`, instants in UTC), tags are joined with "; ". Two more columns follow every entity's own: `exported_at` (the instant
 * the file was generated, on every row) and, in a demo workspace only, `Sample / fictional data`.
 */
type Column<T> = readonly [header: string, value: (row: T) => CsvValue];

export const CUSTOMER_EXPORT_COLUMNS: ReadonlyArray<Column<CustomerDto>> = [
  ["id", (r) => r.id],
  ["display_name", (r) => r.displayName],
  ["company_name", (r) => r.companyName],
  ["type", (r) => r.type],
  ["status", (r) => r.status],
  ["source", (r) => r.source],
  ["email", (r) => r.email],
  ["phone", (r) => r.phone],
  ["website", (r) => r.website],
  ["tags", (r) => r.tags.join("; ")],
  ["notes", (r) => r.notes],
  ["assigned_to", (r) => r.assignedTo],
  ["created_at", (r) => r.createdAt],
  ["updated_at", (r) => r.updatedAt],
  ["archived_at", (r) => r.archivedAt],
];

export const OPPORTUNITY_EXPORT_COLUMNS: ReadonlyArray<Column<OpportunityDto>> = [
  ["id", (r) => r.id],
  ["title", (r) => r.title],
  ["customer_id", (r) => r.customerId],
  ["customer_name", (r) => r.customerName],
  ["stage", (r) => r.stage],
  ["amount_cents", (r) => r.amountCents],
  ["probability_percent", (r) => r.probabilityPercent],
  ["expected_close_date", (r) => r.expectedCloseDate],
  ["assigned_to", (r) => r.assignedTo],
  ["lost_reason", (r) => r.lostReason],
  ["description", (r) => r.description],
  ["closed_at", (r) => r.closedAt],
  ["created_at", (r) => r.createdAt],
  ["updated_at", (r) => r.updatedAt],
  ["archived_at", (r) => r.archivedAt],
];

export const TASK_EXPORT_COLUMNS: ReadonlyArray<Column<TaskDto>> = [
  ["id", (r) => r.id],
  ["title", (r) => r.title],
  ["description", (r) => r.description],
  ["status", (r) => r.status],
  ["priority", (r) => r.priority],
  ["due_date", (r) => r.dueDate],
  ["due_state", (r) => r.dueState],
  ["assigned_to", (r) => r.assignedTo],
  ["customer_id", (r) => r.customerId],
  ["customer_name", (r) => r.customerName],
  ["opportunity_id", (r) => r.opportunityId],
  ["opportunity_title", (r) => r.opportunityTitle],
  ["completed_at", (r) => r.completedAt],
  ["created_at", (r) => r.createdAt],
  ["updated_at", (r) => r.updatedAt],
  ["archived_at", (r) => r.archivedAt],
];

export const REPORT_EXPORT_HEADERS = [
  "section",
  "key",
  "period_start",
  "period_end",
  "metric",
  "value",
] as const;

export const DEMO_MARKER = "Sample / fictional data";
