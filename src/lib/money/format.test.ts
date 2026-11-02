import { describe, expect, it } from "vitest";
import { formatUsd } from "./format";

describe("formatUsd", () => {
  it("formats integer cents as dollars", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1)).toBe("$0.01");
    expect(formatUsd(250000)).toBe("$2,500.00");
    expect(formatUsd(100_000_000_000)).toBe("$1,000,000,000.00");
    expect(formatUsd(123456, { whole: true })).toBe("$1,235");
  });
  it("refuses anything that is not whole cents", () => {
    for (const bad of [1.5, NaN, Infinity]) expect(() => formatUsd(bad)).toThrow(RangeError);
  });
});
