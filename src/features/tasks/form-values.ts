import type { FieldErrors, Resolver } from "react-hook-form";
import { createTaskSchema, updateTaskSchema, type TaskDto } from "./schema";

/** What the drawer edits: every control holds text. The API's own Zod schemas decide what is valid. */
export type TaskFormValues = {
  title: string;
  description: string;
  status: TaskDto["status"];
  priority: TaskDto["priority"];
  /** `YYYY-MM-DD` or blank. A date, never a moment: no time zone can shift it. */
  dueDate: string;
  assignedTo: string;
  customerId: string;
  /** The picked records' names, shown in the pickers. Not sent. */
  customerName: string;
  opportunityId: string;
  opportunityTitle: string;
};

export const EMPTY_TASK: TaskFormValues = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  dueDate: "",
  assignedTo: "",
  customerId: "",
  customerName: "",
  opportunityId: "",
  opportunityTitle: "",
};

export function toTaskFormValues(task: TaskDto): TaskFormValues {
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? "",
    assignedTo: task.assignedTo ?? "",
    customerId: task.customerId ?? "",
    customerName: task.customerName ?? "",
    opportunityId: task.opportunityId ?? "",
    opportunityTitle: task.opportunityTitle ?? "",
  };
}

/** The controls in the order they appear (the error summary uses it). */
export const TASK_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "dueDate",
  "assignedTo",
  "customerId",
  "opportunityId",
] as const satisfies ReadonlyArray<keyof TaskFormValues>;
export type TaskField = (typeof TASK_FIELDS)[number];

export const fieldOfPath = (path: string): TaskField | undefined => {
  const head = path.split(".")[0] as string;
  if (head === "expectedUpdatedAt") return "title";
  return (TASK_FIELDS as readonly string[]).includes(head) ? (head as TaskField) : undefined;
};

export type PayloadOptions = { mode: "create" } | { mode: "edit"; version: string };
type Built =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<TaskField, string>> };

/** The request body for the form values, or the problems per control, using the same schemas as the API. */
export function buildPayload(values: TaskFormValues, options: PayloadOptions): Built {
  const common = {
    title: values.title,
    description: values.description,
    status: values.status,
    priority: values.priority,
    dueDate: values.dueDate,
    assignedTo: values.assignedTo,
    customerId: values.customerId,
    opportunityId: values.opportunityId,
  };
  const parsed =
    options.mode === "create"
      ? createTaskSchema.safeParse(common)
      : updateTaskSchema.safeParse({ ...common, expectedUpdatedAt: options.version });
  if (parsed.success) return { ok: true, body: parsed.data as Record<string, unknown> };
  const errors: Partial<Record<TaskField, string>> = {};
  for (const issue of parsed.error.issues) {
    const field = fieldOfPath(issue.path.map(String).join("."));
    if (field) errors[field] ??= issue.message;
  }
  return { ok: false, errors };
}

export const taskResolver =
  (options: PayloadOptions): Resolver<TaskFormValues> =>
  async (values) => {
    const built = buildPayload(values, options);
    if (built.ok) return { values, errors: {} };
    const errors = Object.fromEntries(
      Object.entries(built.errors).map(([field, message]) => [
        field,
        { type: "validation", message },
      ]),
    );
    return { values: {}, errors: errors as FieldErrors<TaskFormValues> };
  };
