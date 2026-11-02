/**
 * Quote arithmetic: the ONE implementation (PRD US-08, 7.2, 11.1). Pure functions over integer cents and whole basis
 * points, with no floating point anywhere in the money path: every product and sum is a BigInt, and a result that no longer
 * fits a JavaScript safe integer throws instead of being wrong. The database function that saves a quote implements the same
 * formula (and is parity-tested against this module); the browser uses this module only for the live PREVIEW, and the
 * server's answer is the authoritative one.
 *
 *   line      = quantity * unitPriceCents
 *   subtotal  = sum of the lines
 *   taxable   = max(0, subtotal - discount)
 *   tax       = round-half-up(taxable * taxRateBps / 10000)        (a result ending in exactly .5 goes up)
 *   total     = taxable + tax
 */

export const QUANTITY_MIN = 1;
export const QUANTITY_MAX = 100_000;
export const UNIT_PRICE_MAX_CENTS = 100_000_000; // 1,000,000.00
export const TAX_RATE_MAX_BPS = 10_000; // 100.00%

export type QuoteLineInput = { quantity: number; unitPriceCents: number };
export type QuoteInput = {
  lines: readonly QuoteLineInput[];
  discountCents: number;
  taxRateBps: number;
};
export type QuoteTotals = {
  /** Each line's total, in the order given. */
  lineTotalsCents: number[];
  subtotalCents: number;
  discountCents: number;
  taxableCents: number;
  taxCents: number;
  totalCents: number;
};

export type QuoteField = "quantity" | "unitPriceCents" | "discountCents" | "taxRateBps" | "lines";
export type QuoteProblem = { field: QuoteField; line?: number; message: string };

/** Thrown for input the formula must not accept. `problems` names each field, in words a person can act on. */
export class QuoteCalculationError extends RangeError {
  constructor(readonly problems: readonly QuoteProblem[]) {
    super(problems.map((p) => p.message).join(" "));
    this.name = "QuoteCalculationError";
  }
}

const isWhole = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
const big = (n: number) => BigInt(n);
const ZERO = BigInt(0);

function toSafeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new QuoteCalculationError([
      {
        field: "lines",
        message: `The ${what} is too large to calculate exactly. Reduce the quantities or prices.`,
      },
    ]);
  }
  return Number(value);
}

/** Every problem with the input (an empty list when it is acceptable). Never throws; used for form messages. */
export function validateQuoteInput(input: QuoteInput): QuoteProblem[] {
  const problems: QuoteProblem[] = [];
  input.lines.forEach((line, i) => {
    if (!isWhole(line.quantity) || line.quantity < QUANTITY_MIN || line.quantity > QUANTITY_MAX) {
      problems.push({
        field: "quantity",
        line: i,
        message: `Quantity must be a whole number from ${QUANTITY_MIN} to ${QUANTITY_MAX.toLocaleString("en-US")}.`,
      });
    }
    if (
      !isWhole(line.unitPriceCents) ||
      line.unitPriceCents < 0 ||
      line.unitPriceCents > UNIT_PRICE_MAX_CENTS
    ) {
      problems.push({
        field: "unitPriceCents",
        line: i,
        message: "Unit price must be from $0.00 to $1,000,000.00.",
      });
    }
  });
  if (!isWhole(input.discountCents) || input.discountCents < 0) {
    problems.push({ field: "discountCents", message: "Discount must be $0.00 or more." });
  }
  if (!isWhole(input.taxRateBps) || input.taxRateBps < 0 || input.taxRateBps > TAX_RATE_MAX_BPS) {
    problems.push({ field: "taxRateBps", message: "Tax rate must be from 0% to 100%." });
  }
  if (problems.length > 0) return problems;
  // the discount cannot exceed the subtotal (checked only when every number is valid, so the sum can be trusted)
  let subtotal = ZERO;
  for (const line of input.lines) subtotal += big(line.quantity) * big(line.unitPriceCents);
  if (big(input.discountCents) > subtotal) {
    problems.push({
      field: "discountCents",
      message: "The discount cannot be more than the subtotal.",
    });
  }
  return problems;
}

/** The totals for a quote, exactly. Throws `QuoteCalculationError` for any input `validateQuoteInput` would flag. */
export function calculateQuote(input: QuoteInput): QuoteTotals {
  const problems = validateQuoteInput(input);
  if (problems.length > 0) throw new QuoteCalculationError(problems);

  const lineTotals = input.lines.map((l) => big(l.quantity) * big(l.unitPriceCents));
  const subtotal = lineTotals.reduce((a, b) => a + b, ZERO);
  const discount = big(input.discountCents);
  const taxable = subtotal - discount > ZERO ? subtotal - discount : ZERO;
  // round half up: floor((taxable * bps + 5000) / 10000) for non-negative integers
  const tax = (taxable * big(input.taxRateBps) + BigInt(5000)) / BigInt(10_000);
  const total = taxable + tax;
  return {
    lineTotalsCents: lineTotals.map((t) => toSafeNumber(t, "line total")),
    subtotalCents: toSafeNumber(subtotal, "subtotal"),
    discountCents: input.discountCents,
    taxableCents: toSafeNumber(taxable, "taxable amount"),
    taxCents: toSafeNumber(tax, "tax"),
    totalCents: toSafeNumber(total, "total"),
  };
}

// ---- tax rate text <-> whole basis points (no floating point) ------------------------------------------------------------

export type RateParse = { ok: true; bps: number } | { ok: false; message: string };

/** "8.25", "8.25%" or "8" to basis points (825, 825, 800). At most two decimals, from 0 to 100. */
export function parseTaxRateToBps(input: string): RateParse {
  const text = input.trim().replace(/%$/, "").trim();
  if (text === "") return { ok: false, message: "Enter a tax rate, for example 8.25." };
  const match = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(text);
  if (!match)
    return {
      ok: false,
      message: "Enter the tax rate as a percentage with at most 2 decimals, for example 8.25.",
    };
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > TAX_RATE_MAX_BPS)
    return { ok: false, message: "The tax rate cannot be more than 100%." };
  return { ok: true, bps };
}

/** 825 to "8.25%", 800 to "8%", 5 to "0.05%". Display only. */
export function formatTaxRate(bps: number): string {
  if (!isWhole(bps) || bps < 0 || bps > TAX_RATE_MAX_BPS)
    throw new RangeError("A tax rate is from 0 to 10000 basis points.");
  // split the digits of the basis points: 825 is "8" and "25" (no division, so nothing here can become a float)
  const digits = String(bps).padStart(3, "0");
  const whole = digits.slice(0, -2).replace(/^0+(?=\d)/, "");
  const fraction = digits.slice(-2).replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""}%`;
}
