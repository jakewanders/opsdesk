import { describe, expect, it } from "vitest";
import { clamp } from "@/lib/clamp";

describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to the bounds", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
  it("rejects an inverted range", () => {
    expect(() => clamp(1, 10, 0)).toThrow(RangeError);
  });
});
