import { describe, expect, it } from "vitest";
import { needsSession } from "./middleware";

describe("needsSession", () => {
  it.each([
    "/app",
    "/app/customers",
    "/app/settings/members",
    "/demo",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/auth/callback",
    "/api/v1/session",
  ])("refreshes the session for %s", (path) => {
    expect(needsSession(path)).toBe(true);
  });

  it.each(["/", "/privacy", "/terms", "/application", "/demonstration", "/_next/static/x.js"])(
    "leaves %s alone so it stays cacheable",
    (path) => {
      expect(needsSession(path)).toBe(false);
    },
  );
});
