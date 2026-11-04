import { describe, expect, it } from "vitest";
import { barOpacity } from "./bar-emphasis";

describe("barOpacity", () => {
  it("keeps every bar fully visible when none is hovered", () => {
    expect(barOpacity(null, "new")).toBe(1);
    expect(barOpacity(null, "won")).toBe(1);
  });

  it("keeps the hovered bar fully visible and dims the others", () => {
    expect(barOpacity("won", "won")).toBe(1);
    expect(barOpacity("won", "new")).toBe(0.45);
  });
});
