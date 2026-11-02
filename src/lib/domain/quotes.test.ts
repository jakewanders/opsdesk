import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calculateQuote,
  formatTaxRate,
  parseTaxRateToBps,
  QuoteCalculationError,
  validateQuoteInput,
  type QuoteInput,
} from "./quotes";

const q = (lines: Array<[number, number]>, discountCents = 0, taxRateBps = 0): QuoteInput => ({
  lines: lines.map(([quantity, unitPriceCents]) => ({ quantity, unitPriceCents })),
  discountCents,
  taxRateBps,
});

describe("calculateQuote [SIT-174]", () => {
  it("0% tax: total is the subtotal minus the discount", () => {
    expect(
      calculateQuote(
        q(
          [
            [2, 5000],
            [1, 1999],
          ],
          500,
          0,
        ),
      ),
    ).toEqual({
      lineTotalsCents: [10_000, 1_999],
      subtotalCents: 11_999,
      discountCents: 500,
      taxableCents: 11_499,
      taxCents: 0,
      totalCents: 11_499,
    });
  });
  it("a typical sale: 8.25% (825 bps) on 1,234.50", () => {
    const t = calculateQuote(q([[1, 123_450]], 0, 825));
    expect(t.taxCents).toBe(10_185); // 123450 * 0.0825 = 10184.625 -> 10185
    expect(t.totalCents).toBe(133_635);
  });
  it("rounds half up, never half down and never banker's: x.5 goes up, x.49 and x.4999 stay", () => {
    expect(calculateQuote(q([[1, 5]], 0, 1000)).taxCents).toBe(1); // 0.5 -> 1
    expect(calculateQuote(q([[1, 15]], 0, 1000)).taxCents).toBe(2); // 1.5 -> 2
    expect(calculateQuote(q([[1, 25]], 0, 1000)).taxCents).toBe(3); // 2.5 -> 3 (banker's rounding would say 2)
    expect(calculateQuote(q([[1, 3]], 0, 1666)).taxCents).toBe(0); // 0.4998 -> 0
    expect(calculateQuote(q([[1, 4]], 0, 1250)).taxCents).toBe(1); // exactly 0.5 -> 1
    expect(calculateQuote(q([[1, 1]], 0, 4999)).taxCents).toBe(0); // 0.4999 -> 0
    expect(calculateQuote(q([[1, 1]], 0, 5000)).taxCents).toBe(1); // 0.5 -> 1
  });
  it("very small rates: 1 bp (0.01%) of 1,000,000.00 is 100.00; of 99.99 it rounds to 0.01", () => {
    expect(calculateQuote(q([[1, 100_000_000]], 0, 1)).taxCents).toBe(10_000);
    expect(calculateQuote(q([[1, 9_999]], 0, 1)).taxCents).toBe(1);
  });
  it("large amounts stay exact: 20 lines of the maximum quantity at the maximum price, 100% tax", () => {
    const t = calculateQuote(
      q(
        Array.from({ length: 20 }, () => [100_000, 100_000_000] as [number, number]),
        0,
        10_000,
      ),
    );
    expect(t.subtotalCents).toBe(200_000_000_000_000); // 2e14, far beyond what a double sums with cents to spare
    expect(t.taxCents).toBe(200_000_000_000_000);
    expect(t.totalCents).toBe(400_000_000_000_000);
  });
  it("a discount equal to the subtotal leaves nothing taxable; more than the subtotal is refused", () => {
    const t = calculateQuote(q([[3, 1000]], 3000, 825));
    expect([t.taxableCents, t.taxCents, t.totalCents]).toEqual([0, 0, 0]);
    expect(() => calculateQuote(q([[3, 1000]], 3001, 825))).toThrow(QuoteCalculationError);
  });
  it("an empty quote is all zeros", () => {
    expect(calculateQuote(q([], 0, 825)).totalCents).toBe(0);
    expect(() => calculateQuote(q([], 1, 0))).toThrow(/discount cannot be more than the subtotal/);
  });
  it("lines keep their own totals in order", () => {
    expect(
      calculateQuote(
        q([
          [7, 3],
          [1, 0],
          [100_000, 1],
        ]),
      ).lineTotalsCents,
    ).toEqual([21, 0, 100_000]);
  });
});

describe("rejections", () => {
  const field = (input: QuoteInput) =>
    validateQuoteInput(input).map((p) => `${p.field}${p.line === undefined ? "" : `[${p.line}]`}`);
  it("quantity must be a whole number from 1 to 100,000", () => {
    for (const bad of [0, -1, 100_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(field(q([[bad, 100]])), String(bad)).toEqual(["quantity[0]"]);
    }
    expect(
      field(
        q([
          [1, 100],
          [100_000, 100],
        ]),
      ),
    ).toEqual([]);
  });
  it("unit price must be a whole number of cents from 0 to 100,000,000", () => {
    for (const bad of [-1, 100_000_001, 0.5, Number.NaN])
      expect(field(q([[1, bad]])), String(bad)).toEqual(["unitPriceCents[0]"]);
    expect(
      field(
        q([
          [1, 0],
          [1, 100_000_000],
        ]),
      ),
    ).toEqual([]);
  });
  it("negative and fractional discounts, and tax rates outside 0 to 10000 bps or fractional, are refused", () => {
    expect(field(q([[1, 100]], -1))).toEqual(["discountCents"]);
    expect(field(q([[1, 100]], 0.5))).toEqual(["discountCents"]);
    expect(field(q([[1, 100]], 0, -1))).toEqual(["taxRateBps"]);
    expect(field(q([[1, 100]], 0, 10_001))).toEqual(["taxRateBps"]);
    expect(field(q([[1, 100]], 0, 8.25))).toEqual(["taxRateBps"]);
    expect(field(q([[1, 100]], 0, 10_000))).toEqual([]);
  });
  it("reports every problem at once, each naming its line, so a form can show them together", () => {
    const problems = validateQuoteInput(
      q(
        [
          [0, 100],
          [1, -5],
        ],
        -1,
        20_000,
      ),
    );
    expect(problems.map((p) => `${p.field}${p.line ?? ""}`)).toEqual([
      "quantity0",
      "unitPriceCents1",
      "discountCents",
      "taxRateBps",
    ]);
    expect(problems.every((p) => p.message.length > 10)).toBe(true);
  });
  it("overflow: a total beyond the safe integer range is refused, never rounded", () => {
    const lines = Array.from({ length: 1000 }, () => [100_000, 100_000_000] as [number, number]); // 1e16
    expect(() => calculateQuote(q(lines))).toThrow(/too large to calculate exactly/);
    expect(() => calculateQuote(q(lines, 0, 10_000))).toThrow(QuoteCalculationError);
  });
  it("calculateQuote throws a QuoteCalculationError that carries the problems", () => {
    try {
      calculateQuote(q([[0, 100]]));
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(QuoteCalculationError);
      expect((e as QuoteCalculationError).problems[0]).toMatchObject({
        field: "quantity",
        line: 0,
      });
    }
  });
});

describe("tax rate text", () => {
  it.each([
    ["8.25", 825],
    ["8.25%", 825],
    ["8", 800],
    [" 0 ", 0],
    ["100", 10_000],
    ["0.05", 5],
    ["7.5", 750],
    [".5", null],
    ["100.01", null],
    ["8.255", null],
    ["-1", null],
    ["abc", null],
    ["", null],
    ["1e2", null],
  ])("%s", (text, bps) => {
    const r = parseTaxRateToBps(text);
    if (bps === null) expect(r.ok).toBe(false);
    else expect(r).toEqual({ ok: true, bps });
  });
  it("formats basis points as a percentage for display", () => {
    expect([
      formatTaxRate(825),
      formatTaxRate(800),
      formatTaxRate(5),
      formatTaxRate(750),
      formatTaxRate(0),
      formatTaxRate(10_000),
    ]).toEqual(["8.25%", "8%", "0.05%", "7.5%", "0%", "100%"]);
    expect(() => formatTaxRate(10_001)).toThrow(RangeError);
  });
  it("text and number round-trip", () => {
    for (let bps = 0; bps <= 10_000; bps += 7) {
      const text = formatTaxRate(bps);
      expect(parseTaxRateToBps(text)).toEqual({ ok: true, bps });
    }
  });
});

describe("no floating point in the money path", () => {
  it("the module never rounds, floors, parses or formats a float", () => {
    const source = readFileSync("src/lib/domain/quotes.ts", "utf8")
      // comments and strings are not code
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(
      /Math\.(round|floor|ceil|fround)|parseFloat|toFixed|\*\s*0\.\d|\/\s*100\b(?!_)/,
    );
  });
});
