"use client";

import { ConflictDialog } from "@/components/shared/conflict-dialog";
import { applyConflictToForm } from "@/lib/api-client/conflict-form";
import { useConflict } from "@/lib/api-client/use-conflict";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi, useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import type { MemberDto } from "@/features/members/service";
import { CustomerPicker } from "@/features/opportunities/components/customer-picker";
import {
  buildPayload,
  EMPTY_TASK,
  fieldOfPath,
  TASK_FIELDS,
  taskResolver,
  toTaskFormValues,
  type TaskField,
  type TaskFormValues,
} from "../form-values";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskDto } from "../schema";
import { OpportunityPicker } from "./opportunity-picker";
import { PRIORITY_LABELS, STATUS_LABELS } from "./task-labels";

/** `customer` starts a new task attached to that customer (the customer page's "Add task"). */
export type DrawerState =
  { mode: "create"; customer?: { id: string; name: string } } | { mode: "edit"; task: TaskDto };

const SELECT =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const TEXTAREA =
  "min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const LABELS: Record<TaskField, string> = {
  title: "Title",
  description: "Description",
  status: "Status",
  priority: "Priority",
  dueDate: "Due date",
  assignedTo: "Assignee",
  customerId: "Customer",
  opportunityId: "Opportunity",
};
// not `task-<field>`: the list's filter bar already uses ids such as `task-status` and `task-priority`
const fieldId = (name: string) => `task-form-${name}`;

type Props = { state: DrawerState | null; onClose: () => void; currentUserId: string };

/**
 * Add or edit a task in a side drawer. The dialog traps focus and returns it to the control that opened it; Esc closes it
 * when nothing was changed and otherwise asks before discarding. Validation uses the API's own schemas; API field errors
 * land next to their fields. The due date is a plain `YYYY-MM-DD` string end to end, so no time zone can move it.
 */
export function TaskDrawer({ state, onClose, currentUserId }: Props) {
  return (
    <TaskDrawerBody
      key={state ? (state.mode === "edit" ? state.task.id : "create") : "closed"}
      state={state}
      onClose={onClose}
      currentUserId={currentUserId}
    />
  );
}

function TaskDrawerBody({ state, onClose, currentUserId }: Props) {
  const { fetch: call } = useApi();
  const task = state?.mode === "edit" ? state.task : undefined;
  const editing = task !== undefined;
  const [version, setVersion] = useState(task?.updatedAt ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  // The control that opened the drawer (this body is mounted fresh each time it opens): focus goes back to it on close.
  const [opener] = useState(() =>
    typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null),
  );
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const form = useForm<TaskFormValues>({
    resolver: taskResolver(editing ? { mode: "edit", version } : { mode: "create" }),
    defaultValues: task
      ? toTaskFormValues(task)
      : state?.mode === "create" && state.customer
        ? { ...EMPTY_TASK, customerId: state.customer.id, customerName: state.customer.name }
        : EMPTY_TASK,
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { register, control, handleSubmit, setError, reset, setValue, formState, getValues } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;
  const status = useWatch({ control, name: "status" });
  const customerName = useWatch({ control, name: "customerName" });
  const opportunityTitle = useWatch({ control, name: "opportunityTitle" });

  const members = useApiQuery<MemberDto[]>(["members"], "/members", { enabled: state !== null });
  const memberOptions = members.data?.data ?? [];

  const save = useApiMutation<TaskDto, TaskFormValues>({
    mutationFn: (values, { call: send }) => {
      const built = buildPayload(values, editing ? { mode: "edit", version } : { mode: "create" });
      if (!built.ok) throw new Error("The form was submitted with problems.");
      return editing
        ? send(`/tasks/${task.id}`, { method: "PATCH", json: built.body })
        : send("/tasks", { method: "POST", json: built.body });
    },
    invalidate: [["tasks"], ["dashboard"]],
  });
  const archive = useApiMutation<undefined, void>({
    mutationFn: (_v, { call: send }) => send(`/tasks/${task?.id}`, { method: "DELETE" }),
    invalidate: [["tasks"], ["dashboard"]],
  });

  const [baseline, setBaseline] = useState<TaskFormValues>(
    task
      ? toTaskFormValues(task)
      : state?.mode === "create" && state.customer
        ? { ...EMPTY_TASK, customerId: state.customer.id, customerName: state.customer.name }
        : EMPTY_TASK,
  );
  const conflict = useConflict<TaskFormValues>({
    labels: LABELS,
    getBaseline: () => baseline,
    getMine: () => getValues(),
    loadLatest: async () => {
      const latest = await call<TaskDto>(`/tasks/${task?.id}`);
      return { values: toTaskFormValues(latest.data), version: latest.data.updatedAt };
    },
    apply: (values, nextVersion, how, latest) => {
      const mine = getValues();
      applyConflictToForm(form, values, latest, how, setBaseline);
      // the pickers show names that are not editable fields of their own: keep them with the ids the person chose
      if (how === "merge") {
        if (mine.customerId === values.customerId) setValue("customerName", mine.customerName);
        if (mine.opportunityId === values.opportunityId)
          setValue("opportunityTitle", mine.opportunityTitle);
      }
      setVersion(String(nextVersion));
    },
  });

  const requestClose = () => (isDirty ? setConfirmDiscard(true) : onClose());

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await save.mutateAsync(values);
      notify.success(editing ? "Task saved" : "Task added", res.data.title);
      reset(toTaskFormValues(res.data));
      setBaseline(toTaskFormValues(res.data));
      onClose();
    } catch (error) {
      if (!isClientApiError(error))
        return setFormError("Something went wrong and the task was not saved. Try again.");
      if (error.isStaleEdit) return void conflict.report();
      if (error.code === "CUSTOMER_NOT_FOUND" || error.code === "OPPORTUNITY_NOT_FOUND") {
        const field: TaskField =
          error.code === "CUSTOMER_NOT_FOUND" ? "customerId" : "opportunityId";
        return setError(field, {
          type: "server",
          message: "That record was not found in this workspace. Choose another.",
        });
      }
      if (error.isValidation && error.fieldErrors) {
        let placed = 0;
        for (const [path, messages] of Object.entries(error.fieldErrors)) {
          const field = fieldOfPath(path);
          if (field) {
            setError(field, { type: "server", message: messages[0] });
            placed++;
          }
        }
        if (placed === 0) setFormError(error.message);
        return;
      }
      setFormError(
        error.status === 403
          ? "You do not have permission to change tasks in this workspace."
          : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      );
    }
  });

  const summary: ErrorSummaryItem[] = useMemo(
    () =>
      submitCount === 0
        ? []
        : TASK_FIELDS.flatMap((name) => {
            const message = errors[name]?.message;
            return typeof message === "string"
              ? [{ fieldId: fieldId(name), message: `${LABELS[name]}: ${message}` }]
              : [];
          }),
    [errors, submitCount],
  );
  const err = (name: TaskField) =>
    typeof errors[name]?.message === "string" ? (errors[name]?.message as string) : undefined;
  const busy = isSubmitting;

  return (
    <>
      <Sheet open={state !== null} onOpenChange={(open) => !open && requestClose()}>
        <SheetContent
          side="right"
          className="w-full overflow-y-auto sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            // the drawer is opened by state, not by a Trigger, so Radix has nothing to give focus back to
            event.preventDefault();
            const target = opener?.isConnected ? opener : document.getElementById("main-content");
            target?.focus();
          }}
          // Escape inside an open picker list closes the list (the picker handles it), not the whole drawer
          onEscapeKeyDown={(event) => {
            const target = event.target as HTMLElement | null;
            if (
              target?.getAttribute?.("role") === "combobox" &&
              target.getAttribute("aria-expanded") === "true"
            )
              event.preventDefault();
          }}
        >
          <SheetHeader>
            <SheetTitle>{editing ? "Edit task" : "Add task"}</SheetTitle>
            <SheetDescription>
              {editing ? task.title : "Add a task for a customer, a deal, or yourself."}
            </SheetDescription>
          </SheetHeader>

          <form
            noValidate
            onSubmit={onSubmit}
            className="flex flex-col gap-4 px-4 pb-4"
            aria-label={editing ? "Edit task" : "Add task"}
          >
            <ErrorSummary errors={summary} focusKey={submitCount} />
            {formError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
              >
                {formError}
              </div>
            ) : null}

            <FormField
              id={fieldId("title")}
              label="Title"
              required
              error={err("title")}
              hint="2 to 160 characters."
            >
              {(c) => <Input {...c} {...register("title")} autoComplete="off" />}
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id={fieldId("status")} label="Status" error={err("status")}>
                {(c) => (
                  <select {...c} {...register("status")} className={SELECT}>
                    {TASK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField id={fieldId("priority")} label="Priority" error={err("priority")}>
                {(c) => (
                  <select {...c} {...register("priority")} className={SELECT}>
                    {TASK_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABELS[p]}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
              <FormField id={fieldId("dueDate")} label="Due date" error={err("dueDate")}>
                {(c) => <Input {...c} {...register("dueDate")} type="date" />}
              </FormField>
              <FormField id={fieldId("assignedTo")} label="Assignee" error={err("assignedTo")}>
                {(c) => (
                  <Controller
                    control={control}
                    name="assignedTo"
                    render={({ field }) => (
                      <select
                        {...c}
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        className={SELECT}
                        disabled={members.isPending}
                      >
                        <option value="">Unassigned</option>
                        {memberOptions.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.displayName}
                            {m.userId === currentUserId ? " (you)" : ""}
                          </option>
                        ))}
                        {field.value && !memberOptions.some((m) => m.userId === field.value) ? (
                          <option value={field.value}>
                            {members.isPending ? "Loading members..." : "Current assignee"}
                          </option>
                        ) : null}
                      </select>
                    )}
                  />
                )}
              </FormField>
            </div>

            <FormField
              id={fieldId("description")}
              label="Description"
              error={err("description")}
              hint={
                status === "blocked"
                  ? "Optional: say what is blocking this task."
                  : "Plain text, up to 5,000 characters."
              }
            >
              {(c) => <textarea {...c} {...register("description")} className={TEXTAREA} />}
            </FormField>

            <FormField
              id={fieldId("customerId")}
              label="Customer"
              error={err("customerId")}
              hint="Optional."
            >
              {(c) => (
                <Controller
                  control={control}
                  name="customerId"
                  render={({ field }) => (
                    <CustomerPicker
                      control={c}
                      value={field.value}
                      label={customerName}
                      onSelect={(choice) => {
                        field.onChange(choice?.id ?? "");
                        setValue("customerName", choice?.name ?? "", { shouldDirty: true });
                      }}
                      disabled={busy}
                    />
                  )}
                />
              )}
            </FormField>
            <FormField
              id={fieldId("opportunityId")}
              label="Opportunity"
              error={err("opportunityId")}
              hint="Optional."
            >
              {(c) => (
                <Controller
                  control={control}
                  name="opportunityId"
                  render={({ field }) => (
                    <OpportunityPicker
                      control={c}
                      value={field.value}
                      label={opportunityTitle}
                      onSelect={(choice) => {
                        field.onChange(choice?.id ?? "");
                        setValue("opportunityTitle", choice?.name ?? "", { shouldDirty: true });
                      }}
                      disabled={busy}
                    />
                  )}
                />
              )}
            </FormField>

            <SheetFooter className="flex-row flex-wrap gap-2 p-0">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving..." : editing ? "Save changes" : "Add task"}
              </Button>
              <Button type="button" variant="outline" onClick={requestClose}>
                Cancel
              </Button>
              {editing && !task.archivedAt ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setConfirmArchive(true)}
                >
                  Archive task
                </Button>
              ) : null}
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>

      <ConflictDialog noun="task" labels={LABELS} conflict={conflict} />

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard your changes?"
        description="You have unsaved changes. If you close this drawer they will be lost."
        confirmLabel="Discard changes"
        destructive
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this task?"
        description={
          <>
            <strong>{task?.title}</strong> leaves the task list. Its history is kept.
          </>
        }
        confirmLabel="Archive task"
        destructive
        onConfirm={async () => {
          await archive.mutateAsync();
          notify.success("Task archived", task?.title);
          setConfirmArchive(false);
          onClose();
        }}
      />
    </>
  );
}
