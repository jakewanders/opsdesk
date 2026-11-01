import { describe, expect, it } from "vitest";
import { shouldNoindex } from "./robots";

describe("shouldNoindex", () => {
  it.each(["deploy-preview", "branch-deploy", "dev"])("is true for the %s context", (context) => {
    expect(shouldNoindex(context)).toBe(true);
  });

  it("is false for production", () => {
    expect(shouldNoindex("production")).toBe(false);
  });

  it("is false when there is no Netlify context (local, CI)", () => {
    expect(shouldNoindex(undefined)).toBe(false);
    expect(shouldNoindex("")).toBe(false);
  });
});
