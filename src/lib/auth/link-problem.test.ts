import { describe, expect, it } from "vitest";
import { linkProblemFromHash } from "./link-problem";

const FALLBACK = "That link is invalid or has expired.";

describe("linkProblemFromHash", () => {
  it("explains a link that was already used or has expired, and what to do", () => {
    const p = linkProblemFromHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
      FALLBACK,
    );
    expect(p.title).toMatch(/already used or has expired/i);
    expect(p.message).toMatch(/already confirmed.*sign in/i);
    expect(p.message).toMatch(/new confirmation link/i);
  });
  it("falls back to the server's notice for anything else", () => {
    expect(linkProblemFromHash("", FALLBACK)).toEqual({ title: "Link problem", message: FALLBACK });
    expect(linkProblemFromHash("#error=access_denied", FALLBACK).message).toBe(FALLBACK);
    expect(linkProblemFromHash("#error_code=something_else", FALLBACK).message).toBe(FALLBACK);
  });
});
