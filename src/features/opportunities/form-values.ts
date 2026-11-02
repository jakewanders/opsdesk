import type { FieldErrors, Resolver } from "react-hook-form";
import { OPEN_STAGES } from "@/lib/domain/pipeline";
import { formatCentsForInput, parseUsdToCents } from "@/lib/money/parse";
import { createOpportunitySchema, updateOpportunitySchema, type OpportunityDto } from "./schema";

/** What the form edits: every control holds text. The API's own Zod schemas decide what is valid. */
export type OpportunityFormValues = {
  customerId: string;
  /** The picked customer's name, shown in the picker. Not sent. */
  customerName: string;
  title: string;
  description: string;
  stage: (typeof OPEN_STAGES)[number];
  /** US dollars as typed, for example "1,234.50". */
  amount: string;
  /** Blank means "use the stage's default". */
  probability: string;
  expectedCloseDate: string;
  assignedTo: string;
};

export const EMPTY_OPPORTUNITY: OpportunityFormValues = {
  customerId: "",
  customerName: "",
  title: "",
  description: "",
  stage: "new",
  amount: "",
  probability: "",
  expectedCloseDate: "",
  assignedTo: "",
};

export function toOpportunityFormValues(deal: OpportunityDto): OpportunityFormValues {
  return {
    customerId: deal.customerId,
    customerName: deal.customerName ?? "",
    title: deal.title,
    description: deal.description ?? "",
    stage: (OPEN_STAGES as readonly string[]).includes(deal.stage)
      ? (deal.stage as OpportunityFormValues["stage"])
      : "new",
    amount: formatCentsForInput(deal.amountCents),
    probability: String(deal.probabilityPercent),
    expectedCloseDate: deal.expectedCloseDate ?? "",
    assignedTo: deal.assignedTo ?? "",
  };
}

/** The controls in the order they appear (the error summary uses it). */
export const OPPORTUNITY_FIELDS = [
  "customerId",
  "title",
  "description",
  "stage",
  "amount",
  "probability",
  "expectedCloseDate",
  "assignedTo",
] as const satisfies ReadonlyArray<keyof OpportunityFormValues>;
export type OpportunityField = (typeof OPPORTUNITY_FIELDS)[number];

/** API / schema field name to the form control that owns it. */
const CONTROL_OF: Record<string, OpportunityField> = {
  customerId: "customerId",
  title: "title",
  description: "description",
  stage: "stage",
  amountCents: "amount",
  probabilityPercent: "probability",
  expectedCloseDate: "expectedCloseDate",
  assignedTo: "assignedTo",
  expectedUpdatedAt: "title",
};
export const controlOfPath = (path: string): OpportunityField | undefined =>
  CONTROL_OF[path.split(".")[0] ?? path];

export type PayloadOptions =
  { mode: "create" } | { mode: "edit"; version: string; closed: boolean };
type Built =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; errors: Partial<Record<OpportunityField, string>> };

/**
 * The request body for the form values, or the problems per control. Amount is parsed exactly (no floating point);
 * the probability is left out when blank (the database applies the stage's default) and for a closed deal (it is fixed by
 * the stage); everything else is checked by the same Zod schema the API uses.
 */
export function buildPayload(values: OpportunityFormValues, options: PayloadOptions): Built {
  const errors: Partial<Record<OpportunityField, string>> = {};
  const amount = parseUsdToCents(values.amount);
  if (!amount.ok) errors.amount = amount.message;

  let probabilityPercent: number | undefined;
  const probabilityText = values.probability.trim();
  const skipProbability = options.mode === "edit" && options.closed;
  if (probabilityText !== "" && !skipProbability) {
    if (/^\d{1,3}$/.test(probabilityText)) probabilityPercent = Number(probabilityText);
    else errors.probability = "Enter a whole percent from 0 to 100.";
  }

  const common = {
    customerId: values.customerId,
    title: values.title,
    description: values.description,
    amountCents: amount.ok ? amount.cents : 0,
    ...(probabilityPercent === undefined ? {} : { probabilityPercent }),
    expectedCloseDate: values.expectedCloseDate,
    assignedTo: values.assignedTo,
  };
  const candidate =
    options.mode === "create"
      ? { ...common, stage: values.stage }
      : { ...common, expectedUpdatedAt: options.version };
  const parsed = (
    options.mode === "create" ? createOpportunitySchema : updateOpportunitySchema
  ).safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const control = controlOfPath(issue.path.map(String).join("."));
      if (control) errors[control] ??= issue.message;
    }
  }
  if (customerMissing(values)) errors.customerId ??= "Choose a customer.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, body: parsed.success ? (parsed.data as Record<string, unknown>) : candidate };
}

const customerMissing = (values: OpportunityFormValues) => values.customerId.trim() === "";

export const opportunityResolver =
  (options: PayloadOptions): Resolver<OpportunityFormValues> =>
  async (values) => {
    const built = buildPayload(values, options);
    if (built.ok) return { values, errors: {} };
    const errors = Object.fromEntries(
      Object.entries(built.errors).map(([field, message]) => [
        field,
        { type: "validation", message },
      ]),
    );
    return { values: {}, errors: errors as FieldErrors<OpportunityFormValues> };
  };
