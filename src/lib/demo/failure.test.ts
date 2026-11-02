import { describe, expect, it } from "vitest";
import { classifyDemoFailure } from "./failure";

describe("classifyDemoFailure", () => {
  it.each([
    [{ step: "signin", code: "captcha_failed", status: 400 }, "captcha"],
    [{ step: "signin", status: 400 }, "captcha"],
    [{ step: "signin", status: 429, code: "over_request_rate_limit" }, "rate_limit"],
    [{ step: "bootstrap", status: 429, code: "DEMO_CAPACITY" }, "rate_limit"],
    [{ step: "bootstrap", status: 429 }, "rate_limit"],
    [{ step: "signin", network: true }, "unavailable"],
    [{ step: "bootstrap", network: true }, "unavailable"],
    [{ step: "bootstrap", status: 503 }, "unavailable"],
    [{ step: "signin", status: 500, code: "unexpected_failure" }, "unavailable"],
    [{ step: "signin", code: "anonymous_provider_disabled", status: 422 }, "unavailable"],
    [{ step: "bootstrap", status: 403, code: "GUEST_ONLY" }, "member"],
    [{ step: "bootstrap", status: 422, code: "VALIDATION_ERROR" }, "setup"],
    [{ step: "bootstrap", status: 401, code: "UNAUTHENTICATED" }, "setup"],
    [{ step: "bootstrap" }, "setup"],
  ] as const)("%j is %s", (input, kind) => {
    expect(classifyDemoFailure(input).kind).toBe(kind);
  });

  it("is retryable for everything except a signed-in member, and carries the request id", () => {
    for (const kind of ["rate_limit", "captcha", "unavailable", "setup"] as const) {
      const input = {
        rate_limit: { status: 429 },
        captcha: { code: "captcha_failed" },
        unavailable: { network: true },
        setup: {},
      }[kind];
      expect(classifyDemoFailure({ step: "bootstrap", ...input }).retryable, kind).toBe(true);
    }
    const member = classifyDemoFailure({
      step: "bootstrap",
      status: 403,
      code: "GUEST_ONLY",
      requestId: "r-1",
    });
    expect(member).toMatchObject({ retryable: false, requestId: "r-1" });
  });

  it("never uses success wording", () => {
    for (const status of [400, 403, 422, 429, 500, 503]) {
      const f = classifyDemoFailure({ step: "bootstrap", status });
      expect(`${f.title} ${f.message}`).not.toMatch(/\bready\b|welcome|success|opened/i);
    }
  });
});
