const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/**
 * US dollars from integer cents. Money is stored and sent as whole cents; this is the one place it becomes text. Cents
 * stay exact: the largest amount the API accepts (1,000,000,000.00) is far inside what a double holds exactly.
 */
export function formatUsd(cents: number, options: { whole?: boolean } = {}): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("Amounts are whole numbers of cents.");
  return (options.whole ? USD_WHOLE : USD).format(cents / 100);
}
