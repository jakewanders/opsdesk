import { describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { calculateQuote } from "./quotes";
import { EDGES, RANDOM, type Vector } from "./quote-vectors";

/**
 * [SIT-174] TypeScript and SQL agree: the same formula written independently in SQL (numeric arithmetic, half up by
 * `floor(x + 0.5)`, not the integer-division form the module uses) over edge cases and 400 pseudo-random quotes. The database
 * function that saves a quote (SIT-230) must keep these numbers; its own parity test reuses this vector list.
 */
function sqlTotals(v: Vector): { subtotal: number; taxable: number; tax: number; total: number } {
  const lines = v.lines.map(([q, p]) => `(${q}::numeric, ${p}::numeric)`).join(",");
  const sub = v.lines.length
    ? `(select sum(q * p) from (values ${lines}) as l(q, p))`
    : "0::numeric";
  const out = psql(`
    with s as (select ${sub} as subtotal),
    t as (select subtotal, greatest(0, subtotal - ${v.discount}) as taxable from s)
    select subtotal::text || ',' || taxable::text || ',' || floor(taxable * ${v.bps} / 10000 + 0.5)::text || ',' || (taxable + floor(taxable * ${v.bps} / 10000 + 0.5))::text from t`);
  const [subtotal, taxable, tax, total] = out.split(",").map(Number);
  return { subtotal, taxable, tax, total };
}

describe("quote totals: TypeScript equals SQL [SIT-174]", () => {
  it.each([
    ["edge cases", EDGES],
    ["400 pseudo-random quotes", RANDOM],
  ] as const)("%s", (_name, vectors) => {
    for (const v of vectors) {
      const ts = calculateQuote({
        lines: v.lines.map(([quantity, unitPriceCents]) => ({ quantity, unitPriceCents })),
        discountCents: v.discount,
        taxRateBps: v.bps,
      });
      const sql = sqlTotals(v);
      expect(
        {
          subtotal: ts.subtotalCents,
          taxable: ts.taxableCents,
          tax: ts.taxCents,
          total: ts.totalCents,
        },
        JSON.stringify(v),
      ).toEqual(sql);
    }
  });
});
