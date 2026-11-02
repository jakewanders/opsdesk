import { beforeEach, describe, expect, it } from "vitest";
import { clearStashedToken, stashToken, takeStashedToken, tokenFromHash } from "./invite-token";

const T = "a1".repeat(32);

describe("invite token handling", () => {
  beforeEach(() => sessionStorage.clear());

  it("reads a canonical token from the fragment and rejects everything else", () => {
    expect(tokenFromHash(`#token=${T}`)).toBe(T);
    expect(tokenFromHash(`token=${T}`)).toBe(T);
    for (const bad of [
      "",
      "#",
      "#token=",
      `#token=${T.toUpperCase()}`,
      "#token=abc",
      `#x=${T}`,
      `#token=${T}a`,
    ]) {
      expect(tokenFromHash(bad), bad).toBeNull();
    }
  });

  it("a stashed token is read once and then gone", () => {
    stashToken(T);
    expect(takeStashedToken()).toBe(T);
    expect(takeStashedToken()).toBeNull();
  });

  it("a malformed stashed value is ignored and removed", () => {
    sessionStorage.setItem("opsdesk.invite", "not-a-token");
    expect(takeStashedToken()).toBeNull();
    expect(sessionStorage.getItem("opsdesk.invite")).toBeNull();
  });

  it("clearing removes the token", () => {
    stashToken(T);
    clearStashedToken();
    expect(takeStashedToken()).toBeNull();
  });
});
