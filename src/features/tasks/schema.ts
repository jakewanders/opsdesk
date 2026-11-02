import { z } from "zod";
import { expectedUpdatedAtField } from "@/lib/api/concurrency";
import { dueState, type DueState } from "@/lib/domain/tasks";
import { choice, isoDate, listQuery, optionalMultiLine, singleLine, uuid } from "@/lib/validation";

/** The enums mirror the database CHECK constraints (tasks_*_values). */
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
/** Where a reopened task goes (done is the thing being left). */
export const REOPEN_STATUSES = ["todo", "in_progress", "blocked"] as const;

/** Blank or missing becomes null; otherwise the inner schema decides. */
const optional = <T extends z.ZodType<unknown, string>>(schema: T) =>
  z
    .union([z.null(), z.undefined(), z.string()])
    .transform((v) => (v == null || v.trim() === "" ? null : v))
    .pipe(z.union([z.null(), schema]));

/**
 * Body of POST /api/v1/tasks (US-05). Unknown fields are rejected, so `organizationId`, `createdBy` and
 * `completedAt` can never be injected (the database owns `completed_at`). A `blocked` task keeps its reason in the
 * description: no extra validation (PRD 9.5).
 */
export const createTaskSchema = z.strictObject({
  title: singleLine(160, 2),
  description: optionalMultiLine(5000).default(null),
  status: choice(TASK_STATUSES).default("todo"),
  priority: choice(TASK_PRIORITIES).default("medium"),
  dueDate: optional(isoDate()).default(null),
  assignedTo: optional(uuid()).default(null),
  customerId: optional(uuid()).default(null),
  opportunityId: optional(uuid()).default(null),
});
export type CreateTaskInput = z.output<typeof createTaskSchema>;

/** Body of PATCH /api/v1/tasks/:id: every field optional plus the `updatedAt` the client last saw. */
export const updateTaskSchema = z.strictObject({
  ...expectedUpdatedAtField,
  title: singleLine(160, 2).optional(),
  description: optionalMultiLine(5000).optional(),
  status: choice(TASK_STATUSES).optional(),
  priority: choice(TASK_PRIORITIES).optional(),
  dueDate: optional(isoDate()).optional(),
  assignedTo: optional(uuid()).optional(),
  customerId: optional(uuid()).optional(),
  opportunityId: optional(uuid()).optional(),
});
export type UpdateTaskInput = z.output<typeof updateTaskSchema>;

export const PATCH_COLUMNS = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  dueDate: "due_date",
  assignedTo: "assigned_to",
  customerId: "customer_id",
  opportunityId: "opportunity_id",
} as const;

/** Body of POST /api/v1/tasks/:id/complete. `status` is where a reopened task goes (default `todo`). */
export const completeTaskSchema = z.strictObject({
  ...expectedUpdatedAtField,
  completed: z.boolean({ error: "Send true to complete the task or false to reopen it." }),
  status: choice(REOPEN_STATUSES).optional(),
});
export type CompleteTaskInput = z.output<typeof completeTaskSchema>;

export const TASK_SORTS = ["due_date", "priority", "created_at", "updated_at", "title"] as const;

const flag = () => z.enum(["true", "false"], { error: "Use true or false." });

/** Query of GET /api/v1/tasks. */
export const taskListQuery = listQuery({
  sortable: TASK_SORTS,
  defaultSort: "due_date",
  defaultOrder: "asc",
  filters: {
    /** Partial, case-insensitive match on the title. */
    q: singleLine(100).optional(),
    status: choice(TASK_STATUSES).optional(),
    priority: choice(TASK_PRIORITIES).optional(),
    assignedTo: uuid().optional(),
    /** Only tasks assigned to the caller. */
    assignedToMe: flag().optional(),
    /** `true`: not done and due before today in the ORGANIZATION's time zone. */
    overdue: flag().optional(),
    customerId: uuid().optional(),
    opportunityId: uuid().optional(),
    /** `false` (default): active only; `true`: archived only; `all`: both. */
    archived: z
      .enum(["false", "true", "all"], { error: "Use false, true or all." })
      .default("false"),
  },
});
export type TaskListQuery = z.output<typeof taskListQuery>;

export type TaskDto = {
  id: string;
  title: string;
  description: string | null;
  status: (typeof TASK_STATUSES)[number];
  priority: (typeof TASK_PRIORITIES)[number];
  dueDate: string | null;
  /** Overdue / due soon / later / none / done, in the organization's time zone. */
  dueState: DueState;
  assignedTo: string | null;
  customerId: string | null;
  customerName: string | null;
  opportunityId: string | null;
  opportunityTitle: string | null;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type TaskRow = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  due_date: string | null;
  assigned_to: string | null;
  customer_id: string | null;
  opportunity_id: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  customer?: { display_name: string } | null;
  opportunity?: { title: string } | null;
};

export function toTaskDto(row: TaskRow, timeZone: string, now: Date = new Date()): TaskDto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as TaskDto["status"],
    priority: row.priority as TaskDto["priority"],
    dueDate: row.due_date,
    dueState: dueState({ dueDate: row.due_date, status: row.status }, now, timeZone),
    assignedTo: row.assigned_to,
    customerId: row.customer_id,
    customerName: row.customer?.display_name ?? null,
    opportunityId: row.opportunity_id,
    opportunityTitle: row.opportunity?.title ?? null,
    completedAt: row.completed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

/** The columns the API selects, with the linked customer's name and deal's title. */
export const TASK_COLUMNS =
  "id, title, description, status, priority, due_date, assigned_to, customer_id, opportunity_id, completed_at, created_by, created_at, updated_at, archived_at, customer:customers!tasks_customer_fkey(display_name), opportunity:opportunities!tasks_opportunity_fkey(title)";
