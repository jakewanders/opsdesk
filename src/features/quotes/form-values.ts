import type { FieldErrors, Resolver } from "react-hook-form";
import {
  calculateQuote,
  formatTaxRate,
  parseTaxRateToBps,
  validateQuoteInput,
  QUANTITY_MAX,
  QUANTITY_MIN,
  type QuoteTotals,
} from "@/lib/domain/quotes";
import { formatCentsForInput, parseUsdToCents } from "@/lib/money/parse";
import { createQuoteSchema, updateQuoteSchema, type QuoteDetailDto } from "./schema";

/** One line as the controls hold it: text. The shared parsers and Zod schemas decide what is valid. */
export type LineValues = { description: string; quantity: string; unitPrice: string };

export type QuoteFormValues = {
  customerId: string;
  /** The picked customer's name, shown in the picker. Not sent. */
  customerName: string;
  opportunityId: string;
  title: string;
  issueDate: string;
  validUntil: string;
  /** A percentage as typed, for example "8.25". */
  taxRate: string;
  /** US dollars as typed, for example "1,234.50". */
  discount: string;
  notes: string;
  items: LineValues[];
};

export const EMPTY_LINE: LineValues = { description: "", quantity: "1", unitPrice: "" };

export const EMPTY_QUOTE: QuoteFormValues = {
  customerId: "",
  customerName: "",
  opportunityId: "",
  title: "",
  issueDate: "",
  validUntil: "",
  taxRate: "0",
  discount: "0.00",
  notes: "",
  items: [EMPTY_LINE],
};

export function toQuoteFormValues(quote: QuoteDetailDto): QuoteFormValues {
  return {
    customerId: quote.customerId,
    customerName: quote.customerName ?? "",
    opportunityId: quote.opportunityId ?? "",
    title: quote.title,
    issueDate: quote.issueDate,
    validUntil: quote.validUntil ?? "",
    taxRate: formatTaxRate(quote.taxRateBps).replace(/%$/, ""),
    discount: formatCentsForInput(quote.discountCents),
    notes: quote.notes ?? "",
    items: quote.items.map((i) => ({
      description: i.description,
      quantity: String(i.quantity),
      unitPrice: formatCentsForInput(i.unitPriceCents),
    })),
  };
}

export type HeaderField =
  | "customerId"
  | "opportunityId"
  | "title"
  | "issueDate"
  | "validUntil"
  | "taxRate"
  | "discount"
  | "notes";
export type LineField = keyof LineValues;

/** The header controls in the order they appear (the error summary uses it). */
export const HEADER_FIELDS: readonly HeaderField[] = [
  "customerId",
  "opportunityId",
  "title",
  "issueDate",
  "validUntil",
  "discount",
  "taxRate",
  "notes",
];

export type Problems = {
  header: Partial<Record<HeaderField, string>>;
  /** A problem with the lines as a whole (none at all, too many). */
  items?: string;
  lines: Array<Partial<Record<LineField, string>>>;
};

export function parseQuantity(
  text: string,
): { ok: true; quantity: number } | { ok: false; message: string } {
  const t = text.trim();
  if (t === "") return { ok: false, message: "Enter a quantity." };
  if (!/^\d{1,9}$/.test(t))
    return {
      ok: false,
      message: `Quantity must be a whole number from ${QUANTITY_MIN} to ${QUANTITY_MAX.toLocaleString("en-US")}.`,
    };
  const n = Number(t);
  if (n < QUANTITY_MIN || n > QUANTITY_MAX)
    return {
      ok: false,
      message: `Quantity must be a whole number from ${QUANTITY_MIN} to ${QUANTITY_MAX.toLocaleString("en-US")}.`,
    };
  return { ok: true, quantity: n };
}

type Interpreted = {
  lines: Array<{ description: string; quantity: number; unitPriceCents: number }>;
  discountCents: number;
  taxRateBps: number;
  problems: Problems;
};

/** Everything the controls say, parsed exactly (no floating point), with every problem named per control and per line. */
function interpret(values: QuoteFormValues): Interpreted {
  const problems: Problems = { header: {}, lines: values.items.map(() => ({})) };
  const lines: Interpreted["lines"] = [];
  let linesOk = true;
  values.items.forEach((item, i) => {
    const description = item.description.trim();
    if (description.length < 2 || description.length > 300)
      problems.lines[i].description = "Describe the item in 2 to 300 characters.";
    const quantity = parseQuantity(item.quantity);
    if (!quantity.ok) problems.lines[i].quantity = quantity.message;
    const price = parseUsdToCents(item.unitPrice);
    if (!price.ok) problems.lines[i].unitPrice = price.message;
    else if (price.cents > 100_000_000)
      problems.lines[i].unitPrice = "Unit price must be from $0.00 to $1,000,000.00.";
    if (problems.lines[i].description || problems.lines[i].quantity || problems.lines[i].unitPrice)
      linesOk = false;
    else
      lines.push({
        description,
        quantity: (quantity as { quantity: number }).quantity,
        unitPriceCents: (price as { cents: number }).cents,
      });
  });
  if (values.items.length === 0) problems.items = "Add at least one line item.";
  if (values.items.length > 100) problems.items = "A quote can have at most 100 line items.";

  const discountText = values.discount.trim() === "" ? "0" : values.discount;
  const discount = parseUsdToCents(discountText);
  if (!discount.ok) problems.header.discount = discount.message;
  const rate = parseTaxRateToBps(values.taxRate.trim() === "" ? "0" : values.taxRate);
  if (!rate.ok) problems.header.taxRate = rate.message;

  const discountCents = discount.ok ? discount.cents : 0;
  const taxRateBps = rate.ok ? rate.bps : 0;
  // the shared rules: a discount above the subtotal, and sums too large to be exact
  if (linesOk && discount.ok && rate.ok && lines.length > 0) {
    for (const p of validateQuoteInput({ lines, discountCents, taxRateBps })) {
      if (p.field === "discountCents") problems.header.discount ??= p.message;
      else if (p.field === "taxRateBps") problems.header.taxRate ??= p.message;
      else problems.items ??= p.message;
    }
  }
  return { lines: linesOk ? lines : [], discountCents, taxRateBps, problems };
}

export type Preview = { ok: true; totals: QuoteTotals } | { ok: false };

/**
 * The live preview: the shared calculation module over what is typed, or `ok: false` while anything is invalid or incomplete. It
 * is a PREVIEW: the server recomputes everything on save and its totals are the saved ones.
 */
export function quotePreview(values: QuoteFormValues): Preview {
  const view = interpret(values);
  const bad =
    view.lines.length === 0 ||
    view.lines.length !== values.items.length ||
    view.problems.header.discount ||
    view.problems.header.taxRate ||
    view.problems.items;
  if (bad) return { ok: false };
  try {
    return {
      ok: true,
      totals: calculateQuote({
        lines: view.lines,
        discountCents: view.discountCents,
        taxRateBps: view.taxRateBps,
      }),
    };
  } catch {
    return { ok: false };
  }
}

export type PayloadMode = { mode: "create" } | { mode: "edit"; version: number };
type Built = { ok: true; body: Record<string, unknown> } | { ok: false; problems: Problems };

const CONTROL_OF: Record<string, HeaderField | "items"> = {
  customerId: "customerId",
  opportunityId: "opportunityId",
  title: "title",
  issueDate: "issueDate",
  validUntil: "validUntil",
  taxRateBps: "taxRate",
  discountCents: "discount",
  notes: "notes",
  items: "items",
};
export const controlOfPath = (path: string) => CONTROL_OF[path.split(".")[0] ?? path];

/** The request body for the form values (create or edit), or the problems per control and per line. */
export function buildPayload(values: QuoteFormValues, options: PayloadMode): Built {
  const view = interpret(values);
  const problems = view.problems;
  if (values.customerId.trim() === "") problems.header.customerId = "Choose a customer.";
  const candidate = {
    customerId: values.customerId,
    opportunityId: values.opportunityId === "" ? null : values.opportunityId,
    title: values.title,
    issueDate: values.issueDate === "" ? null : values.issueDate,
    validUntil: values.validUntil === "" ? null : values.validUntil,
    taxRateBps: view.taxRateBps,
    discountCents: view.discountCents,
    notes: values.notes,
    items: view.lines,
  };
  const parsed =
    options.mode === "create"
      ? createQuoteSchema.safeParse(candidate)
      : updateQuoteSchema.safeParse({
          ...candidate,
          issueDate: candidate.issueDate ?? undefined,
          expectedVersion: options.version,
        });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      const control = controlOfPath(path[0] ?? "");
      if (control === "items") {
        // per-line problems are already named by `interpret`; a Zod message here is a whole-list one
        if (path.length === 1) problems.items ??= issue.message;
      } else if (control) problems.header[control] ??= issue.message;
    }
  }
  const anyLine = problems.lines.some((l) => Object.keys(l).length > 0);
  if (Object.keys(problems.header).length > 0 || problems.items || anyLine)
    return { ok: false, problems };
  return { ok: true, body: parsed.success ? (parsed.data as Record<string, unknown>) : candidate };
}

type FieldError = { type: string; message: string };
export const quoteResolver =
  (options: PayloadMode): Resolver<QuoteFormValues> =>
  async (values) => {
    const built = buildPayload(values, options);
    if (built.ok) return { values, errors: {} };
    const { header, items, lines } = built.problems;
    const errors: Record<string, unknown> = {};
    for (const [field, message] of Object.entries(header))
      errors[field] = { type: "validation", message } satisfies FieldError;
    const rows = lines.map((l) =>
      Object.fromEntries(
        Object.entries(l).map(([f, message]) => [
          f,
          { type: "validation", message } satisfies FieldError,
        ]),
      ),
    );
    if (rows.some((r) => Object.keys(r).length > 0) || items) {
      errors.items = Object.assign(
        rows,
        items ? { root: { type: "validation", message: items } } : {},
      );
    }
    return { values: {}, errors: errors as FieldErrors<QuoteFormValues> };
  };

export type Mismatch = { field: string; preview: number; saved: number };

/** Where the browser's preview and the server's saved totals disagree (an empty list when they agree, as they should). */
export function compareWithServer(preview: Preview, saved: QuoteDetailDto): Mismatch[] {
  if (!preview.ok) return [];
  const t = preview.totals;
  return (
    [
      ["subtotal", t.subtotalCents, saved.subtotalCents],
      ["tax", t.taxCents, saved.taxCents],
      ["total", t.totalCents, saved.totalCents],
    ] as const
  )
    .filter(([, a, b]) => a !== b)
    .map(([field, previewCents, savedCents]) => ({
      field,
      preview: previewCents,
      saved: savedCents,
    }));
}

/** Moves one line (used by the buttons and by drag and drop). Out-of-range targets leave the list unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length)
    return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
