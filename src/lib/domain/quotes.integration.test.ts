import { describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { calculateQuote } from "./quotes";

/**
 * [SIT-174] TypeScript and SQL agree: the same formula written independently in SQL (numeric arithmetic, half up by
 * `floor(x + 0.5)`, not the integer-division form the module uses) over edge cases and 400 pseudo-random quotes. The database
 * function that saves a quote (SIT-230) must keep these numbers; its own parity test reuses this vector list.
 */
const rng = (() => {
  let s = 20261102;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
})();
const pick = (max: number) => Math.floor(rng() * (max + 1));

type Vector = { lines: Array<[number, number]>; discount: number; bps: number };
const EDGES: Vector[] = [
  { lines: [[1, 5]], discount: 0, bps: 1000 },
  { lines: [[1, 25]], discount: 0, bps: 1000 },
  { lines: [[1, 4]], discount: 0, bps: 1250 },
  { lines: [[1, 3]], discount: 0, bps: 1666 },
  { lines: [[1, 123_450]], discount: 0, bps: 825 },
  {
    lines: [
      [100_000, 100_000_000],
      [100_000, 100_000_000],
    ],
    discount: 1,
    bps: 10_000,
  },
  { lines: [[3, 1000]], discount: 3000, bps: 825 },
  {
    lines: [
      [7, 3],
      [1, 0],
      [100_000, 1],
    ],
    discount: 11,
    bps: 1,
  },
  { lines: [], discount: 0, bps: 500 },
];
const RANDOM: Vector[] = Array.from({ length: 400 }, () => {
  const lines = Array.from(
    { length: 1 + pick(6) },
    () => [1 + pick(99_999), pick(rng() < 0.5 ? 10_000 : 100_000_000)] as [number, number],
  );
  const subtotal = lines.reduce((a, [qty, price]) => a + qty * price, 0);
  return {
    lines,
    discount: rng() < 0.5 ? 0 : pick(Math.min(subtotal, 9_000_000_000_000)),
    bps: pick(10_000),
  };
});

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
