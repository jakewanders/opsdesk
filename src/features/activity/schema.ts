import { z } from "zod";
import { choice, isoDate, listQuery, uuid } from "@/lib/validation";

export const ACTIVITY_ENTITY_TYPES = ["customer", "opportunity", "task", "quote"] as const;
export const ACTIVITY_ACTIONS = [
  "created",
  "updated",
  "archived",
  "restored",
  "deleted",
  "stage_changed",
  "completed",
  "reopened",
  "sent",
  "approved",
  "rejected",
  "imported",
] as const;

/**
 * Query of GET /api/v1/activity. `sort` is `created_at` only (newest first by default). Filters: `entityType`,
 * `entityId` (a record's timeline), `action`, `actor` (a member's user id, or `system` for automatic events) and `from` /
 * `to` (inclusive calendar days in the organization's time zone).
 */
export const activityListQuery = listQuery({
  sortable: ["created_at"] as const,
  defaultSort: "created_at",
  defaultOrder: "desc",
  filters: {
    entityType: choice(ACTIVITY_ENTITY_TYPES).optional(),
    entityId: uuid().optional(),
    action: choice(ACTIVITY_ACTIONS).optional(),
    actor: z.union([z.literal("system"), uuid()], { error: "Use a user ID or system." }).optional(),
    from: isoDate().optional(),
    to: isoDate().optional(),
  },
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: "from must not be after to.",
  path: ["from"],
});
export type ActivityListQuery = z.output<typeof activityListQuery>;
