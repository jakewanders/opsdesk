import { formatUsd } from "@/lib/money/format";

/** Plain words for the fields the activity log whitelists. Anything else shows under its own name. */
export const FIELD_LABELS: Record<string, string> = {
  display_name: "name",
  company_name: "company",
  assigned_to: "owner",
  customer_id: "customer",
  opportunity_id: "opportunity",
  amount_cents: "amount",
  probability_percent: "probability",
  expected_close_date: "expected close date",
  due_date: "due date",
  title: "title",
  type: "type",
  status: "status",
  priority: "priority",
  stage: "stage",
  source: "source",
  tags: "tags",
  email: "email",
  phone: "phone",
  website: "website",
  notes: "notes",
  description: "description",
  lost_reason: "lost reason",
};

/** A stored change value as plain text (never markup): money as dollars, lists joined, empty as "none". */
export function showChange(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (field === "amount_cents" && typeof value === "number" && Number.isSafeInteger(value))
    return formatUsd(value);
  if (field === "probability_percent" && typeof value === "number") return `${value}%`;
  if (Array.isArray(value)) return value.join(", ");
  // enum-like values read as words: in_progress becomes "in progress"
  if (
    typeof value === "string" &&
    ["status", "priority", "stage", "type", "source"].includes(field)
  )
    return value.replace(/_/g, " ");
  return String(value);
}
