"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { notify } from "@/components/shared/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi, useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { DEFAULT_PROBABILITY, OPEN_STAGES, STAGE_LABELS } from "@/lib/domain/pipeline";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { MemberDto } from "@/features/members/service";
import {
  buildPayload,
  controlOfPath,
  EMPTY_OPPORTUNITY,
  OPPORTUNITY_FIELDS,
  opportunityResolver,
  toOpportunityFormValues,
  type OpportunityField,
  type OpportunityFormValues,
} from "../form-values";
import type { OpportunityDto } from "../schema";
import { CustomerPicker } from "./customer-picker";

type Props = {
  /** Present when editing. */
  deal?: OpportunityDto;
  /** A customer to start with when adding (for example from a customer page). */
  initialCustomer?: { id: string; name: string };
  currentUserId: string;
};

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const TEXTAREA_CLASS =
  "min-h-28 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const LABELS: Record<OpportunityField, string> = {
  customerId: "Customer",
  title: "Title",
  description: "Description",
  stage: "Stage",
  amount: "Amount",
  probability: "Probability",
  expectedCloseDate: "Expected close date",
  assignedTo: "Owner",
};
const fieldId = (name: string) => `opportunity-${name}`;

/**
 * Add or edit an opportunity. Amount is typed in US dollars and converted to integer cents without floating point; the
 * same Zod schemas as the API check everything else. The stage is chosen only when adding: afterwards it changes through
 * the stage control (which owns the lost-reason and closing rules).
 */
export function OpportunityForm({ deal, initialCustomer, currentUserId }: Props) {
  const router = useRouter();
  const { fetch: call } = useApi();
  const editing = deal !== undefined;
  const closed = deal ? deal.stage === "won" || deal.stage === "lost" : false;
  const [version, setVersion] = useState(deal?.updatedAt ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const form = useForm<OpportunityFormValues>({
    resolver: opportunityResolver(editing ? { mode: "edit", version, closed } : { mode: "create" }),
    defaultValues: deal
      ? toOpportunityFormValues(deal)
      : {
          ...EMPTY_OPPORTUNITY,
          customerId: initialCustomer?.id ?? "",
          customerName: initialCustomer?.name ?? "",
        },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { register, control, handleSubmit, setError, reset, setValue, formState } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;
  const stage = useWatch({ control, name: "stage" });
  const customerName = useWatch({ control, name: "customerName" });

  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const memberOptions = members.data?.data ?? [];

  const save = useApiMutation<OpportunityDto, OpportunityFormValues>({
    mutationFn: (values, { call: send }) => {
      const built = buildPayload(
        values,
        editing ? { mode: "edit", version, closed } : { mode: "create" },
      );
      if (!built.ok) throw new Error("The form was submitted with problems.");
      return editing
        ? send(`/opportunities/${deal.id}`, { method: "PATCH", json: built.body })
        : send("/opportunities", { method: "POST", json: built.body });
    },
    invalidate: [["opportunities-board"], ["opportunity"], ["dashboard"]],
  });

  const guard = useUnsavedChangesGuard(isDirty);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setStale(false);
    try {
      const res = await save.mutateAsync(values);
      reset(toOpportunityFormValues(res.data));
      setVersion(res.data.updatedAt);
      notify.success(editing ? "Opportunity saved" : "Opportunity added", res.data.title);
      router.push(`/app/opportunities/${res.data.id}`);
    } catch (error) {
      if (!isClientApiError(error)) {
        setFormError("Something went wrong and the opportunity was not saved. Try again.");
        return;
      }
      if (error.isStaleEdit) return setStale(true);
      if (error.code === "CUSTOMER_NOT_FOUND" || (error.status === 404 && !editing)) {
        setError("customerId", {
          type: "server",
          message: "That customer was not found in this workspace. Choose another.",
        });
        return;
      }
      if (error.isValidation && error.fieldErrors) {
        let placed = 0;
        for (const [path, messages] of Object.entries(error.fieldErrors)) {
          const control = controlOfPath(path);
          if (control) {
            setError(control, { type: "server", message: messages[0] });
            placed++;
          }
        }
        if (placed === 0) setFormError(error.message);
        return;
      }
      setFormError(
        error.status === 403
          ? "You do not have permission to change opportunities in this workspace."
          : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      );
    }
  });

  const reload = async () => {
    if (!deal) return;
    try {
      const latest = await call<OpportunityDto>(`/opportunities/${deal.id}`);
      reset(toOpportunityFormValues(latest.data));
      setVersion(latest.data.updatedAt);
      setStale(false);
      notify.info("Loaded the latest version", "Your changes were discarded.");
    } catch {
      setFormError("The latest version could not be loaded. Reload the page.");
    }
  };

  const summary: ErrorSummaryItem[] = useMemo(
    () =>
      submitCount === 0
        ? []
        : OPPORTUNITY_FIELDS.flatMap((name) => {
            const message = errors[name]?.message;
            return typeof message === "string"
              ? [{ fieldId: fieldId(name), message: `${LABELS[name]}: ${message}` }]
              : [];
          }),
    [errors, submitCount],
  );
  const err = (name: OpportunityField) =>
    typeof errors[name]?.message === "string" ? (errors[name]?.message as string) : undefined;
  const busy = isSubmitting;
  const defaultProbability = DEFAULT_PROBABILITY[editing ? deal.stage : stage];

  return (
    <>
      <form
        noValidate
        onSubmit={onSubmit}
        className="flex max-w-2xl flex-col gap-5"
        aria-label={editing ? "Edit opportunity" : "Add opportunity"}
      >
        <ErrorSummary errors={summary} focusKey={submitCount} />
        {stale ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
          >
            <p className="font-semibold">Someone else changed this opportunity.</p>
            <p className="mt-1">
              Your changes were not saved. Load the latest version, then make your edit again.
            </p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => void reload()}>
              Load the latest version
            </Button>
          </div>
        ) : null}
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
          >
            {formError}
          </div>
        ) : null}

        <FormField
          id={fieldId("customerId")}
          label="Customer"
          required
          error={err("customerId")}
          hint="Search by name, company or email."
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
                  onSelect={(customer) => {
                    field.onChange(customer?.id ?? "");
                    setValue("customerName", customer?.name ?? "", { shouldDirty: true });
                  }}
                  disabled={busy}
                />
              )}
            />
          )}
        </FormField>

        <FormField
          id={fieldId("title")}
          label="Title"
          required
          error={err("title")}
          hint="2 to 150 characters."
        >
          {(c) => <Input {...c} {...register("title")} autoComplete="off" />}
        </FormField>

        <div className="grid gap-5 sm:grid-cols-2">
          {editing ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium">Stage</p>
              <p className="text-sm">{STAGE_LABELS[deal.stage]}</p>
              <p className="text-sm text-muted-foreground">
                Change the stage from the opportunity page.
              </p>
            </div>
          ) : (
            <FormField id={fieldId("stage")} label="Stage" error={err("stage")}>
              {(c) => (
                <select {...c} {...register("stage")} className={SELECT_CLASS}>
                  {OPEN_STAGES.map((s) => (
                    <option key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
          )}
          <FormField
            id={fieldId("amount")}
            label="Amount"
            required
            error={err("amount")}
            hint="In US dollars, for example 1,234.50."
          >
            {(c) => <Input {...c} {...register("amount")} inputMode="decimal" autoComplete="off" />}
          </FormField>
          <FormField
            id={fieldId("probability")}
            label="Probability (%)"
            error={err("probability")}
            hint={
              closed
                ? "Fixed by the stage."
                : `Leave blank to use the default for the stage: ${defaultProbability}%.`
            }
          >
            {(c) => (
              <Input
                {...c}
                {...register("probability")}
                inputMode="numeric"
                autoComplete="off"
                disabled={closed}
                placeholder={`${defaultProbability}`}
              />
            )}
          </FormField>
          <FormField
            id={fieldId("expectedCloseDate")}
            label="Expected close date"
            error={err("expectedCloseDate")}
          >
            {(c) => <Input {...c} {...register("expectedCloseDate")} type="date" />}
          </FormField>
        </div>

        <FormField
          id={fieldId("assignedTo")}
          label="Owner"
          error={err("assignedTo")}
          hint="Only members of this workspace can be the owner."
        >
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
                  className={SELECT_CLASS}
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
                      {members.isPending ? "Loading members..." : "Current owner"}
                    </option>
                  ) : null}
                </select>
              )}
            />
          )}
        </FormField>

        <FormField
          id={fieldId("description")}
          label="Description"
          error={err("description")}
          hint="Plain text, up to 5,000 characters."
        >
          {(c) => <textarea {...c} {...register("description")} className={TEXTAREA_CLASS} />}
        </FormField>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : editing ? "Save changes" : "Add opportunity"}
          </Button>
          <Link
            href={editing ? `/app/opportunities/${deal.id}` : "/app/opportunities"}
            className={buttonVariants({ variant: "outline" })}
          >
            Cancel
          </Link>
        </div>
      </form>

      <ConfirmDialog
        open={guard.pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) guard.stay();
        }}
        title="Discard your changes?"
        description="You have unsaved changes. If you leave this page they will be lost."
        confirmLabel="Discard changes"
        destructive
        onConfirm={guard.confirmLeave}
      />
    </>
  );
}
