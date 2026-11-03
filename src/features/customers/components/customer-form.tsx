"use client";

import { ConflictDialog } from "@/components/shared/conflict-dialog";
import { applyConflictToForm } from "@/lib/api-client/conflict-form";
import { useConflict } from "@/lib/api-client/use-conflict";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { notify } from "@/components/shared/toast";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi, useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import type { MemberDto } from "@/features/members/service";
import {
  customerResolver,
  EMPTY_CUSTOMER,
  FIELD_ORDER,
  fieldOfPath,
  toFormValues,
  toPayload,
  type CustomerFormValues,
} from "../form-values";
import { CUSTOMER_SOURCES, CUSTOMER_STATUSES, CUSTOMER_TYPES, type CustomerDto } from "../schema";
import { STATUS_LABELS } from "./customer-status";
import { TagsInput } from "./tags-input";

type Warning = { code: string; message: string; customerId?: string };

type Props = {
  /** Present when editing; absent when adding. */
  customer?: CustomerDto;
  currentUserId: string;
};

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const TEXTAREA_CLASS =
  "min-h-28 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";

const TYPE_LABELS = { person: "Person", company: "Company" } as const;
const SOURCE_LABELS = {
  referral: "Referral",
  website: "Website",
  outbound: "Outbound",
  other: "Other",
} as const;
const FIELD_LABELS: Record<(typeof FIELD_ORDER)[number], string> = {
  type: "Type",
  displayName: "Display name",
  companyName: "Company",
  email: "Email",
  phone: "Phone",
  website: "Website",
  status: "Status",
  source: "Source",
  tags: "Tags",
  notes: "Notes",
  assignedTo: "Owner",
};
const fieldId = (name: string) => `customer-${name}`;

/**
 * Add or edit a customer. Validation is the API's own Zod schema (same rules, same messages); server `fieldErrors` land
 * next to their fields too. Every control is a native, labelled element. The page stays put after a failed save, keeps
 * what was typed, and announces the problems in a summary that links to each field.
 */
export function CustomerForm({ customer, currentUserId }: Props) {
  const router = useRouter();
  const { fetch: call } = useApi();
  const editing = customer !== undefined;
  const [version, setVersion] = useState(customer?.updatedAt ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ customer: CustomerDto; warnings: Warning[] } | null>(null);

  const form = useForm<CustomerFormValues>({
    resolver: customerResolver,
    defaultValues: customer ? toFormValues(customer) : EMPTY_CUSTOMER,
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { register, control, handleSubmit, setError, reset, formState, getValues } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;

  const members = useApiQuery<MemberDto[]>(["members"], "/members");
  const memberOptions = members.data?.data ?? [];

  const save = useApiMutation<CustomerDto, CustomerFormValues>({
    mutationFn: (values, { call }) => {
      const payload = toPayload(values);
      return editing
        ? call(`/customers/${customer.id}`, {
            method: "PATCH",
            json: { ...payload, expectedUpdatedAt: version },
          })
        : call("/customers", { method: "POST", json: payload });
    },
    invalidate: [["customers"], ["dashboard"]],
  });

  const guard = useUnsavedChangesGuard(isDirty && saved === null);

  // What the form was last reset to: the version the person started from, for working out what a conflict is about.
  const [baseline, setBaseline] = useState<CustomerFormValues>(
    customer ? toFormValues(customer) : EMPTY_CUSTOMER,
  );
  const conflict = useConflict<CustomerFormValues>({
    labels: FIELD_LABELS,
    getBaseline: () => baseline,
    getMine: () => getValues(),
    loadLatest: async () => {
      const latest = await call<CustomerDto>(`/customers/${customer?.id}`);
      return { values: toFormValues(latest.data), version: latest.data.updatedAt };
    },
    apply: (values, nextVersion, how, latest) => {
      applyConflictToForm(form, values, latest, how, setBaseline);
      setVersion(String(nextVersion));
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const res = await save.mutateAsync(values);
      const warnings = ((res.meta.warnings as Warning[] | undefined) ?? []).filter(
        (w) => w.code === "DUPLICATE_EMAIL",
      );
      reset(toFormValues(res.data));
      setBaseline(toFormValues(res.data));
      setVersion(res.data.updatedAt);
      notify.success(editing ? "Customer saved" : "Customer added", res.data.displayName);
      if (warnings.length > 0) setSaved({ customer: res.data, warnings });
      else router.push(`/app/customers/${res.data.id}`);
    } catch (error) {
      if (!isClientApiError(error)) {
        setFormError("Something went wrong and the customer was not saved. Try again.");
        return;
      }
      if (error.isStaleEdit) {
        void conflict.report();
        return;
      }
      if (error.isValidation && error.fieldErrors) {
        let placed = 0;
        for (const [path, messages] of Object.entries(error.fieldErrors)) {
          const field = fieldOfPath(path);
          if ((FIELD_ORDER as readonly string[]).includes(field)) {
            setError(field as keyof CustomerFormValues, { type: "server", message: messages[0] });
            placed++;
          }
        }
        if (placed === 0) setFormError(error.message);
        return;
      }
      setFormError(
        error.status === 403
          ? "You do not have permission to change customers in this workspace."
          : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      );
    }
  });

  const summary: ErrorSummaryItem[] = useMemo(
    () =>
      submitCount === 0
        ? []
        : FIELD_ORDER.flatMap((name) => {
            const message = errors[name]?.message;
            return typeof message === "string"
              ? [{ fieldId: fieldId(name), message: `${FIELD_LABELS[name]}: ${message}` }]
              : [];
          }),
    [errors, submitCount],
  );

  if (saved) {
    const dup = saved.warnings[0];
    return (
      <div className="flex max-w-2xl flex-col gap-4" role="status">
        <p className="text-base font-medium">{editing ? "Customer saved." : "Customer added."}</p>
        <div className="rounded-lg border border-border bg-muted/50 p-4 text-sm">
          <p className="font-medium">Another customer in this workspace has this email.</p>
          <p className="mt-1 text-muted-foreground">
            This is only a heads-up: {saved.customer.displayName} was saved.
            {dup?.customerId ? (
              <>
                {" "}
                <Link
                  href={`/app/customers/${dup.customerId}`}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Open the existing customer
                </Link>
                .
              </>
            ) : null}
          </p>
        </div>
        <div className="flex gap-2">
          <Link href={`/app/customers/${saved.customer.id}`} className={buttonVariants()}>
            Continue to {saved.customer.displayName}
          </Link>
          <Link href="/app/customers" className={buttonVariants({ variant: "outline" })}>
            Back to customers
          </Link>
        </div>
      </div>
    );
  }

  const busy = isSubmitting;
  const err = (name: keyof CustomerFormValues) =>
    typeof errors[name]?.message === "string" ? (errors[name]?.message as string) : undefined;

  return (
    <>
      <form
        noValidate
        onSubmit={onSubmit}
        className="flex max-w-2xl flex-col gap-5"
        aria-label={editing ? "Edit customer" : "Add customer"}
      >
        <ErrorSummary errors={summary} focusKey={submitCount} />
        {formError ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
          >
            {formError}
          </div>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField id={fieldId("type")} label="Type" error={err("type")}>
            {(c) => (
              <select {...c} {...register("type")} className={SELECT_CLASS}>
                {CUSTOMER_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField
            id={fieldId("displayName")}
            label="Display name"
            required
            error={err("displayName")}
            hint="2 to 120 characters."
          >
            {(c) => <Input {...c} {...register("displayName")} autoComplete="off" />}
          </FormField>
          <FormField id={fieldId("companyName")} label="Company" error={err("companyName")}>
            {(c) => <Input {...c} {...register("companyName")} autoComplete="organization" />}
          </FormField>
          <FormField id={fieldId("email")} label="Email" error={err("email")}>
            {(c) => <Input {...c} {...register("email")} type="email" autoComplete="off" />}
          </FormField>
          <FormField id={fieldId("phone")} label="Phone" error={err("phone")}>
            {(c) => <Input {...c} {...register("phone")} type="tel" autoComplete="off" />}
          </FormField>
          <FormField
            id={fieldId("website")}
            label="Website"
            error={err("website")}
            hint="Starts with http:// or https://"
          >
            {(c) => <Input {...c} {...register("website")} type="url" autoComplete="off" />}
          </FormField>
          <FormField id={fieldId("status")} label="Status" error={err("status")}>
            {(c) => (
              <select {...c} {...register("status")} className={SELECT_CLASS}>
                {CUSTOMER_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <FormField id={fieldId("source")} label="Source" error={err("source")}>
            {(c) => (
              <select {...c} {...register("source")} className={SELECT_CLASS}>
                {CUSTOMER_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
              </select>
            )}
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
          id={fieldId("tags")}
          label="Tags"
          error={err("tags")}
          hint="Up to 10 tags, 30 characters each. Press Enter to add one."
        >
          {(c) => (
            <Controller
              control={control}
              name="tags"
              render={({ field }) => (
                <TagsInput
                  control={c}
                  value={field.value}
                  onChange={field.onChange}
                  disabled={busy}
                />
              )}
            />
          )}
        </FormField>

        <FormField
          id={fieldId("notes")}
          label="Notes"
          error={err("notes")}
          hint="Plain text, up to 5,000 characters."
        >
          {(c) => <textarea {...c} {...register("notes")} className={TEXTAREA_CLASS} />}
        </FormField>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? "Saving..." : editing ? "Save changes" : "Add customer"}
          </Button>
          <Link
            href={editing ? `/app/customers/${customer.id}` : "/app/customers"}
            className={buttonVariants({ variant: "outline" })}
          >
            Cancel
          </Link>
        </div>
      </form>

      <ConflictDialog noun="customer" labels={FIELD_LABELS} conflict={conflict} />
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
