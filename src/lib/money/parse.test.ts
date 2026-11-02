import { describe, expect, it } from "vitest";
import { MAX_CENTS } from "@/lib/validation";
import { formatCentsForInput, parseUsdToCents } from "./parse";

const ok = (text: string) => {
  const r = parseUsdToCents(text);
  if (!r.ok) throw new Error(`expected ${JSON.stringify(text)} to parse, got: ${r.message}`);
  return r.cents;
};
const bad = (text: string) => {
  const r = parseUsdToCents(text);
  expect(r.ok, JSON.stringify(text)).toBe(false);
  return r.ok ? "" : r.message;
};

describe("parseUsdToCents", () => {
  it("1,234.50 is 123450 cents", () => {
    expect(ok("1,234.50")).toBe(123450);
  });
  it("parses whole dollars, one or two decimals, a dollar sign, thousands commas and spaces around", () => {
    expect(ok("0")).toBe(0);
    expect(ok("5")).toBe(500);
    expect(ok("5.")).toBe(500);
    expect(ok("5.5")).toBe(550);
    expect(ok("5.05")).toBe(505);
    expect(ok(".5")).toBe(50);
    expect(ok("$1,234,567.89")).toBe(123456789);
    expect(ok("  250000  ")).toBe(25000000);
    expect(ok("1000000000")).toBe(MAX_CENTS);
  });
  it("is exact where floating point is not (no multiplication by 100 anywhere)", () => {
    // 0.07 * 100 === 7.000000000000001, 1.15 * 100 === 114.99999999999999, 4.35 * 100 === 434.99999999999994
    expect(ok("0.07")).toBe(7);
    expect(ok("1.15")).toBe(115);
    expect(ok("4.35")).toBe(435);
    expect(ok("19.99")).toBe(1999);
    expect(ok("8.2")).toBe(820);
    expect(ok("999999999.99")).toBe(99999999999);
  });
  it("rejects negative values, more than 2 decimals and anything that is not a plain amount, with a message that says what to do", () => {
    expect(bad("-5")).toMatch(/negative|0 or more/i);
    expect(bad("-0.01")).toMatch(/negative|0 or more/i);
    expect(bad("1.234")).toMatch(/2 decimal/i);
    expect(bad("1.2345")).toMatch(/2 decimal/i);
    for (const text of [
      "",
      "   ",
      "abc",
      "1e3",
      "1.2.3",
      "1,23",
      "12,34,567",
      ",100",
      "1,,000",
      "1 000",
      "5%",
      "NaN",
      "Infinity",
      "0x10",
      "١٢٣",
      "--5",
      "+5",
      "5-",
      "$",
      "$$5",
      "€5",
      "5 USD",
    ])
      bad(text);
    expect(bad("")).toMatch(/enter an amount/i);
  });
  it("rejects amounts over the largest the API accepts", () => {
    expect(bad("1000000000.01")).toMatch(/too large/i);
    expect(bad("99999999999999999999")).toMatch(/too large/i);
  });
});

describe("formatCentsForInput", () => {
  it("writes cents as an amount the parser reads back exactly", () => {
    expect(formatCentsForInput(123450)).toBe("1,234.50");
    expect(formatCentsForInput(0)).toBe("0.00");
    expect(formatCentsForInput(7)).toBe("0.07");
    expect(formatCentsForInput(MAX_CENTS)).toBe("1,000,000,000.00");
  });
  it("round-trips every amount in a sweep, including awkward cents", () => {
    for (let cents = 0; cents < 200_000; cents += 7)
      expect(ok(formatCentsForInput(cents))).toBe(cents);
    for (const cents of [
      1,
      99,
      100,
      101,
      999_999,
      1_000_001,
      123_456_789,
      99_999_999_999,
      MAX_CENTS,
    ])
      expect(ok(formatCentsForInput(cents))).toBe(cents);
  });
  it("refuses cents that are not whole, negative or too large", () => {
    for (const bad of [1.5, -1, NaN, MAX_CENTS + 1])
      expect(() => formatCentsForInput(bad)).toThrow(RangeError);
  });
});
