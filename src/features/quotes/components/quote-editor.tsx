"use client";

import { ConflictDialog } from "@/components/shared/conflict-dialog";
import { applyConflictToForm } from "@/lib/api-client/conflict-form";
import { useConflict } from "@/lib/api-client/use-conflict";
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
import { CustomerPicker } from "@/features/opportunities/components/customer-picker";
import type { OpportunityDto } from "@/features/opportunities/schema";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi, useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { parseTaxRateToBps } from "@/lib/domain/quotes";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import {
  buildPayload,
  compareWithServer,
  controlOfPath,
  EMPTY_QUOTE,
  HEADER_FIELDS,
  quotePreview,
  quoteResolver,
  toQuoteFormValues,
  type HeaderField,
  type QuoteFormValues,
} from "../form-values";
import type { QuoteDetailDto } from "../schema";
import { LineItems, rowId } from "./line-items";
import { QuoteSummary } from "./quote-summary";

type Props = {
  /** Present when editing a draft. */
  quote?: QuoteDetailDto;
  /** A customer (and deal) to start with when creating, for example from a customer page. */
  initial?: { customerId: string; customerName: string; opportunityId?: string };
};

const TEXTAREA_CLASS =
  "min-h-24 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 disabled:opacity-50 dark:bg-input/30";
const LABELS: Record<HeaderField, string> = {
  customerId: "Customer",
  opportunityId: "Opportunity",
  title: "Title",
  issueDate: "Issue date",
  validUntil: "Valid until",
  discount: "Discount",
  taxRate: "Tax rate",
  notes: "Notes",
};
const fieldId = (name: string) => `quote-${name}`;

/**
 * Create a quote or edit a draft (PRD 9.6). Everything typed is text; the amounts are parsed exactly into cents and the tax
 * rate into basis points, checked by the same Zod schemas and calculation rules as the API, and previewed with the shared
 * calculation module. Saving sends lines, discount and rate only: the SERVER computes and returns the saved totals (and, for a
 * new quote, its number), which then replace the preview. A stale version (409) offers to load the latest.
 */
/** The fields a conflict can be about, in the words the form uses. */
const CONFLICT_LABELS = {
  customerId: "Customer",
  opportunityId: "Deal",
  title: "Title",
  issueDate: "Issue date",
  validUntil: "Valid until",
  taxRate: "Tax rate",
  discount: "Discount",
  notes: "Notes",
  items: "Line items",
} as const;

export function QuoteEditor({ quote, initial }: Props) {
  const router = useRouter();
  const { fetch: call } = useApi();
  const editing = quote !== undefined;
  const [version, setVersion] = useState(quote?.version ?? 1);
  const [saved, setSaved] = useState<QuoteDetailDto | null>(null);
  const [savedPreview, setSavedPreview] = useState<ReturnType<typeof quotePreview> | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState<"locked" | null>(null);

  const form = useForm<QuoteFormValues>({
    resolver: quoteResolver(editing ? { mode: "edit", version } : { mode: "create" }),
    defaultValues: quote
      ? toQuoteFormValues(quote)
      : {
          ...EMPTY_QUOTE,
          customerId: initial?.customerId ?? "",
          customerName: initial?.customerName ?? "",
          opportunityId: initial?.opportunityId ?? "",
        },
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { register, control, handleSubmit, setError, reset, setValue, formState, getValues } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;
  const values = useWatch({ control }) as QuoteFormValues;
  const customerId = useWatch({ control, name: "customerId" });
  const customerName = useWatch({ control, name: "customerName" });

  const preview = useMemo(() => quotePreview(values), [values]);
  const rate = parseTaxRateToBps(values.taxRate?.trim() === "" ? "0" : (values.taxRate ?? "0"));
  const taxRateBps = rate.ok ? rate.bps : null;

  const deals = useApiQuery<OpportunityDto[]>(["quote-deals", customerId], "/opportunities", {
    query: { customerId, limit: 100, archived: "false", sort: "title", order: "asc" },
    enabled: customerId !== "",
  });

  const save = useApiMutation<QuoteDetailDto, QuoteFormValues>({
    idempotent: !editing,
    mutationFn: (v, { call: send, key }) => {
      const built = buildPayload(v, editing ? { mode: "edit", version } : { mode: "create" });
      if (!built.ok) throw new Error("The form was submitted with problems.");
      return editing
        ? send<QuoteDetailDto>(`/quotes/${quote.id}`, { method: "PATCH", json: built.body })
        : send<QuoteDetailDto>("/quotes", {
            method: "POST",
            json: built.body,
            idempotencyKey: key,
          });
    },
    invalidate: [["quotes"], ["quote"], ["dashboard"]],
  });

  const guard = useUnsavedChangesGuard(isDirty);

  const [baseline, setBaseline] = useState<QuoteFormValues>(
    quote
      ? toQuoteFormValues(quote)
      : {
          ...EMPTY_QUOTE,
          customerId: initial?.customerId ?? "",
          customerName: initial?.customerName ?? "",
          opportunityId: initial?.opportunityId ?? "",
        },
  );
  const conflict = useConflict<QuoteFormValues>({
    labels: CONFLICT_LABELS,
    getBaseline: () => baseline,
    getMine: () => getValues(),
    loadLatest: async () => {
      const latest = await call<QuoteDetailDto>(`/quotes/${quote?.id}`);
      if (latest.data.status !== "draft") {
        // it was sent while the person was editing: the quote page is the only place left to go
        router.refresh();
        router.push(`/app/quotes/${quote?.id}`);
        return null;
      }
      return { values: toQuoteFormValues(latest.data), version: latest.data.version };
    },
    apply: (values, nextVersion, how, latest) => {
      const mine = getValues();
      applyConflictToForm(form, values, latest, how, setBaseline);
      if (how === "merge" && mine.customerId === values.customerId)
        setValue("customerName", mine.customerName);
      setVersion(Number(nextVersion));
      setSaved(null);
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    setFormError(null);
    setStale(null);
    const submittedPreview = quotePreview(v);
    try {
      const res = await save.mutateAsync(v);
      const next = res.data;
      setSaved(next);
      setSavedPreview(submittedPreview);
      reset(toQuoteFormValues(next));
      setBaseline(toQuoteFormValues(next));
      setVersion(next.version);
      notify.success(
        editing ? "Draft saved" : "Quote created",
        `${next.quoteNumber}: ${next.title}`,
      );
      if (!editing) router.push(`/app/quotes/${next.id}`);
    } catch (error) {
      if (!isClientApiError(error)) {
        setFormError("Something went wrong and the quote was not saved. Try again.");
        return;
      }
      if (error.isStaleEdit) return void conflict.report();
      if (error.code === "QUOTE_LOCKED") return setStale("locked");
      if (error.isValidation && error.fieldErrors) {
        let placed = 0;
        for (const [path, messages] of Object.entries(error.fieldErrors)) {
          const control = controlOfPath(path);
          if (control && control !== "items") {
            setError(control, { type: "server", message: messages[0] });
            placed++;
          }
        }
        if (placed === 0) setFormError(error.message);
        return;
      }
      const placedByCode: Record<string, HeaderField> = {
        CUSTOMER_NOT_FOUND: "customerId",
        CUSTOMER_ARCHIVED: "customerId",
        OPPORTUNITY_NOT_FOUND: "opportunityId",
        OPPORTUNITY_MISMATCH: "opportunityId",
        DISCOUNT_TOO_LARGE: "discount",
        INVALID_DISCOUNT: "discount",
        INVALID_TAX_RATE: "taxRate",
        INVALID_DATES: "validUntil",
        INVALID_TITLE: "title",
      };
      const target = placedByCode[error.code];
      if (target) return setError(target, { type: "server", message: error.message });
      setFormError(
        error.status === 403
          ? "You do not have permission to change quotes in this workspace."
          : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      );
    }
  });

  const reload = async () => {
    if (!quote) return;
    try {
      const latest = await call<QuoteDetailDto>(`/quotes/${quote.id}`);
      if (latest.data.status !== "draft") {
        router.refresh();
        router.push(`/app/quotes/${quote.id}`);
        return;
      }
      reset(toQuoteFormValues(latest.data));
      setBaseline(toQuoteFormValues(latest.data));
      setVersion(latest.data.version);
      setSaved(null);
      setStale(null);
      notify.info("Loaded the latest version", "Your changes were discarded.");
    } catch {
      setFormError("The latest version could not be loaded. Reload the page.");
      setStale(null);
    }
  };

  const summary: ErrorSummaryItem[] = useMemo(() => {
    if (submitCount === 0) return [];
    const out: ErrorSummaryItem[] = [];
    for (const name of HEADER_FIELDS) {
      const message = errors[name]?.message;
      if (typeof message === "string")
        out.push({ fieldId: fieldId(name), message: `${LABELS[name]}: ${message}` });
    }
    const rootMessage = errors.items?.root?.message;
    if (typeof rootMessage === "string")
      out.push({ fieldId: "quote-lines-title", message: `Line items: ${rootMessage}` });
    const rows = errors.items;
    if (Array.isArray(rows)) {
      rows.forEach((row, i) => {
        for (const [f, label] of [
          ["description", "description"],
          ["quantity", "quantity"],
          ["unitPrice", "unit price"],
        ] as const) {
          const message = row?.[f]?.message;
          if (typeof message === "string")
            out.push({ fieldId: rowId(i, f), message: `Line ${i + 1}, ${label}: ${message}` });
        }
      });
    }
    return out;
  }, [errors, submitCount]);
  const err = (name: HeaderField) =>
    typeof errors[name]?.message === "string" ? (errors[name]?.message as string) : undefined;
  const busy = isSubmitting;
  const mismatches = saved && savedPreview ? compareWithServer(savedPreview, saved) : [];

  return (
    <>
      <form
        noValidate
        onSubmit={onSubmit}
        aria-label={editing ? "Edit quote" : "New quote"}
        className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]"
      >
        <div className="flex min-w-0 flex-col gap-6">
          <ErrorSummary errors={summary} focusKey={submitCount} />
          {stale === "locked" ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
            >
              <p className="font-semibold">This quote was sent while you were editing.</p>
              <p className="mt-1">
                A sent quote cannot be changed. Your edits were not saved; revise the quote to make
                a new draft.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => void reload()}
              >
                Open the current quote
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

          <section aria-labelledby="quote-details-title" className="flex flex-col gap-5">
            <h2 id="quote-details-title" className="text-lg font-semibold">
              Details
            </h2>
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
                        setValue("opportunityId", "", { shouldDirty: true });
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
              hint="Optional. Only this customer's opportunities are listed."
            >
              {(c) => (
                <select
                  {...c}
                  {...register("opportunityId")}
                  className={SELECT_CLASS}
                  disabled={busy || customerId === ""}
                >
                  <option value="">{customerId === "" ? "Choose a customer first" : "None"}</option>
                  {(deals.data?.data ?? []).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField
              id={fieldId("title")}
              label="Title"
              required
              error={err("title")}
              hint="2 to 150 characters."
            >
              {(c) => <Input {...c} {...register("title")} autoComplete="off" disabled={busy} />}
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                id={fieldId("issueDate")}
                label="Issue date"
                error={err("issueDate")}
                hint="Leave blank for today."
              >
                {(c) => <Input {...c} {...register("issueDate")} type="date" disabled={busy} />}
              </FormField>
              <FormField id={fieldId("validUntil")} label="Valid until" error={err("validUntil")}>
                {(c) => <Input {...c} {...register("validUntil")} type="date" disabled={busy} />}
              </FormField>
            </div>
          </section>

          <LineItems form={form} disabled={busy} />

          <section aria-labelledby="quote-adjust-title" className="flex flex-col gap-5">
            <h2 id="quote-adjust-title" className="text-lg font-semibold">
              Discount, tax and notes
            </h2>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField
                id={fieldId("discount")}
                label="Discount (USD)"
                error={err("discount")}
                hint="A fixed amount taken off the subtotal."
              >
                {(c) => (
                  <Input
                    {...c}
                    {...register("discount")}
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    disabled={busy}
                  />
                )}
              </FormField>
              <FormField
                id={fieldId("taxRate")}
                label="Tax rate (%)"
                error={err("taxRate")}
                hint="Up to 2 decimals, for example 8.25."
              >
                {(c) => (
                  <Input
                    {...c}
                    {...register("taxRate")}
                    inputMode="decimal"
                    autoComplete="off"
                    className="tabular-nums"
                    disabled={busy}
                  />
                )}
              </FormField>
            </div>
            <FormField
              id={fieldId("notes")}
              label="Notes"
              error={err("notes")}
              hint="Plain text, up to 5,000 characters."
            >
              {(c) => (
                <textarea
                  {...c}
                  {...register("notes")}
                  className={TEXTAREA_CLASS}
                  disabled={busy}
                />
              )}
            </FormField>
          </section>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving..." : editing ? "Save draft" : "Create quote"}
            </Button>
            <Link
              href={editing ? `/app/quotes/${quote.id}` : "/app/quotes"}
              className={buttonVariants({ variant: "outline" })}
            >
              Cancel
            </Link>
          </div>
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <QuoteSummary
            preview={preview}
            taxRateBps={taxRateBps}
            saved={saved}
            mismatches={mismatches}
          />
        </aside>
      </form>

      <ConflictDialog noun="quote" labels={CONFLICT_LABELS} conflict={conflict} />
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
