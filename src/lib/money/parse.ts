import { MAX_CENTS } from "@/lib/validation/primitives";

export type MoneyParse = { ok: true; cents: number } | { ok: false; message: string };

// Optional $, then digits either plain or with correctly placed thousands commas, then optional .0 to .99.
// Anything else (exponents, other currencies, spaces inside, stray commas) is refused rather than guessed at.
const AMOUNT = /^\$?(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{0,2}))?|\.(\d{1,2}))$/;

/**
 * Text a person typed to integer cents, WITHOUT floating point: the digits are split at the decimal point and combined as
 * whole numbers ("1,234.50" is 1234 * 100 + 50 = 123450). Rejects negatives, more than two decimals, and
 * anything over the largest amount the API accepts. This is the one parser every money field uses (quotes later too).
 */
export function parseUsdToCents(input: string): MoneyParse {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Enter an amount, for example 1,234.50." };
  if (/^[-−(]/.test(text) || /-/.test(text.replace(/^\$/, "")))
    return {
      ok: false,
      message: "Enter an amount of 0 or more. Negative amounts are not allowed.",
    };
  if (/^\$?[\d,]*\.\d{3,}/.test(text))
    return { ok: false, message: "Use at most 2 decimal places, for example 1,234.50." };
  const match = AMOUNT.exec(text);
  if (!match)
    return { ok: false, message: "Enter a plain amount in dollars, for example 1,234.50." };

  const whole = (match[1] ?? "0").replace(/,/g, "");
  const fraction = (match[2] ?? match[3] ?? "").padEnd(2, "0");
  // Compare as text first: a very long number must not lose digits on its way to a double.
  const trimmed = whole.replace(/^0+(?=\d)/, "");
  if (trimmed.length > 10 || Number(trimmed) * 100 + Number(fraction) > MAX_CENTS)
    return {
      ok: false,
      message: "That amount is too large. The most you can enter is 1,000,000,000.00.",
    };
  return { ok: true, cents: Number(trimmed) * 100 + Number(fraction) };
}

const GROUPED = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer cents as the text an input shows: `123450` becomes `1,234.50`. The parser reads it back exactly. */
export function formatCentsForInput(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > MAX_CENTS)
    throw new RangeError("Amounts are whole, non-negative cents within the supported range.");
  // Whole dollars and cents are formatted separately so no division can round.
  const dollars = Math.floor(cents / 100);
  const rest = String(cents % 100).padStart(2, "0");
  return `${GROUPED.format(dollars).replace(/\.00$/, "")}.${rest}`;
}
