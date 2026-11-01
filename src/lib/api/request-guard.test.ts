import { describe, expect, it } from "vitest";
import { ForbiddenError, PayloadTooLargeError } from "./errors";
import {
  assertContentLengthWithin,
  assertTrustedOrigin,
  computeTrustedOrigins,
  DEFAULT_MAX_BODY_BYTES,
  readTextWithLimit,
} from "./request-guard";

const APP = "https://opsdesk.sitelaunch.dev";
const req = (method: string, headers: Record<string, string> = {}, body?: BodyInit) =>
  new Request(`${APP}/api/v1/things`, { method, headers, body });

describe("computeTrustedOrigins", () => {
  it("is just the app origin in production, whatever the deploy URL says", () => {
    expect(
      computeTrustedOrigins({
        appUrl: `${APP}/`,
        context: "production",
        deployPrimeUrl: "https://evil.example",
      }),
    ).toEqual([APP]);
  });
  it("adds the deploy's own https origin only in preview contexts", () => {
    const base = { appUrl: APP, deployPrimeUrl: "https://deploy-preview-4--opsdesk.netlify.app/x" };
    for (const context of ["deploy-preview", "branch-deploy"]) {
      expect(computeTrustedOrigins({ ...base, context })).toEqual([
        APP,
        "https://deploy-preview-4--opsdesk.netlify.app",
      ]);
    }
    expect(computeTrustedOrigins({ ...base, context: undefined })).toEqual([APP]);
  });
  it("ignores a non-https or unparsable preview URL", () => {
    expect(
      computeTrustedOrigins({
        appUrl: APP,
        context: "deploy-preview",
        deployPrimeUrl: "http://x.test",
      }),
    ).toEqual([APP]);
    expect(
      computeTrustedOrigins({
        appUrl: APP,
        context: "deploy-preview",
        deployPrimeUrl: "not a url",
      }),
    ).toEqual([APP]);
  });
});

describe("assertTrustedOrigin", () => {
  const trusted = [APP];
  const blocked = (r: Request) =>
    expect(() => assertTrustedOrigin(r, trusted)).toThrow(ForbiddenError);

  it("never checks safe methods", () => {
    for (const m of ["GET", "HEAD", "OPTIONS"]) {
      expect(() =>
        assertTrustedOrigin(req(m, { origin: "https://evil.example" }), trusted),
      ).not.toThrow();
    }
  });
  it("accepts a matching Origin on every mutating method", () => {
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(() => assertTrustedOrigin(req(m, { origin: APP }), trusted)).not.toThrow();
    }
  });
  it("rejects a forged Origin", () => {
    blocked(req("POST", { origin: "https://evil.example" }));
    blocked(req("POST", { origin: "https://opsdesk.sitelaunch.dev.evil.example" }));
    blocked(req("POST", { origin: "http://opsdesk.sitelaunch.dev" }));
    blocked(req("POST", { origin: "https://opsdesk.sitelaunch.dev:8443" }));
    blocked(req("POST", { origin: `${APP}/path` }));
  });
  it("rejects the opaque Origin: null", () => {
    blocked(req("POST", { origin: "null" }));
  });
  it("rejects a mutation with neither Origin nor Sec-Fetch-Site", () => {
    blocked(req("POST"));
  });
  it("falls back to Sec-Fetch-Site when Origin is absent", () => {
    expect(() =>
      assertTrustedOrigin(req("POST", { "sec-fetch-site": "same-origin" }), trusted),
    ).not.toThrow();
    expect(() =>
      assertTrustedOrigin(req("POST", { "sec-fetch-site": "none" }), trusted),
    ).not.toThrow();
    blocked(req("POST", { "sec-fetch-site": "same-site" }));
    blocked(req("POST", { "sec-fetch-site": "cross-site" }));
  });
  it("rejects cross-site Sec-Fetch-Site even when Origin matches", () => {
    blocked(req("POST", { origin: APP, "sec-fetch-site": "cross-site" }));
  });
  it("ignores Host and X-Forwarded-Host entirely", () => {
    blocked(
      req("POST", { host: "opsdesk.sitelaunch.dev", "x-forwarded-host": "opsdesk.sitelaunch.dev" }),
    );
    blocked(
      req("POST", {
        origin: "https://evil.example",
        "x-forwarded-host": "opsdesk.sitelaunch.dev",
        "x-forwarded-proto": "https",
      }),
    );
  });
  it("uses a distinct machine code", () => {
    try {
      assertTrustedOrigin(req("POST"), trusted);
    } catch (e) {
      expect((e as ForbiddenError).code).toBe("ORIGIN_FORBIDDEN");
    }
  });
});

describe("body limits", () => {
  it("defaults to 100 KB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(102400);
  });
  it("rejects a declared Content-Length over the cap, before reading", () => {
    expect(() => assertContentLengthWithin(req("POST", { "content-length": "101" }), 100)).toThrow(
      PayloadTooLargeError,
    );
    expect(() =>
      assertContentLengthWithin(req("POST", { "content-length": "100" }), 100),
    ).not.toThrow();
  });
  it("rejects a malformed Content-Length", () => {
    expect(() =>
      assertContentLengthWithin(req("POST", { "content-length": "12abc" }), 100),
    ).toThrow();
  });
  it("stops reading a stream without Content-Length once the cap is passed", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(40));
        if (pulled > 1000) controller.close();
      },
    });
    const request = new Request(`${APP}/x`, {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expect(readTextWithLimit(request, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled).toBeLessThan(10);
  });
  it("returns the text of a body at the cap", async () => {
    await expect(readTextWithLimit(req("POST", {}, "x".repeat(100)), 100)).resolves.toHaveLength(
      100,
    );
    await expect(readTextWithLimit(req("POST", {}, "x".repeat(101)), 100)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });
});
