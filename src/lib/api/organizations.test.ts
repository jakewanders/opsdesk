import { describe, expect, it } from "vitest";
import { createOrganizationSchema, isIanaTimeZone, toWorkspaces } from "./organizations";
import type { MembershipRow } from "./org-context";

describe("isIanaTimeZone (mirrors the database rule)", () => {
  it("accepts UTC and Area/City names", () => {
    for (const ok of [
      "UTC",
      "America/New_York",
      "Europe/London",
      "Asia/Kolkata",
      "America/Argentina/Buenos_Aires",
    ])
      expect(isIanaTimeZone(ok), ok).toBe(true);
  });
  it("rejects abbreviations, aliases, unknown zones and junk", () => {
    for (const bad of [
      "EST",
      "PST8PDT",
      "posix/UTC",
      "right/UTC",
      "Mars/Base",
      "",
      "America/",
      "/UTC",
      "Not A Zone",
      "../etc/passwd",
    ])
      expect(isIanaTimeZone(bad), bad).toBe(false);
  });
});

describe("createOrganizationSchema", () => {
  it("accepts a name alone, and trims", () => {
    expect(createOrganizationSchema.parse({ name: "  Acme Plumbing " })).toEqual({
      name: "Acme Plumbing",
    });
  });
  it("accepts industry and timezone", () => {
    expect(
      createOrganizationSchema.parse({
        name: "Acme",
        industry: " Plumbing ",
        timezone: "America/Chicago",
      }),
    ).toEqual({ name: "Acme", industry: "Plumbing", timezone: "America/Chicago" });
  });
  it("turns a blank industry into null", () => {
    expect(createOrganizationSchema.parse({ name: "Acme", industry: "  " }).industry).toBeNull();
  });
  it("reports field errors for short, long, markup and missing names", () => {
    for (const name of ["A", "x".repeat(81), "<script>x</script>", "", "   "]) {
      const r = createOrganizationSchema.safeParse({ name });
      expect(r.success, name).toBe(false);
    }
    expect(createOrganizationSchema.safeParse({}).success).toBe(false);
  });
  it("rejects a bad time zone, an over-long industry and unknown fields (no owner or id smuggling)", () => {
    expect(createOrganizationSchema.safeParse({ name: "Acme", timezone: "EST" }).success).toBe(
      false,
    );
    expect(
      createOrganizationSchema.safeParse({ name: "Acme", industry: "y".repeat(81) }).success,
    ).toBe(false);
    for (const extra of [
      { owner_id: "x" },
      { organization_id: "x" },
      { kind: "demo" },
      { expires_at: "2099-01-01" },
      { role: "owner" },
    ]) {
      expect(
        createOrganizationSchema.safeParse({ name: "Acme", ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
  });
});

describe("toWorkspaces", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const row = (id: string, name: string, over = {}, role = "owner"): MembershipRow => ({
    role,
    organizations: { id, name, kind: "real", expires_at: null, timezone: "UTC", ...over },
  });
  it("summarizes real and demo workspaces", () => {
    const out = toWorkspaces(
      [
        row("b", "Beta", {}, "viewer"),
        row("a", "Alpha", { kind: "demo", expires_at: "2026-11-01T13:00:00Z" }),
      ],
      now,
    );
    expect(out.map((w) => w.name)).toEqual(["Alpha", "Beta"]);
    expect(out[0]).toMatchObject({
      kind: "demo",
      role: "owner",
      secondsRemaining: 3600,
      expired: false,
      expiresAt: "2026-11-01T13:00:00Z",
    });
    expect(out[1]).toMatchObject({
      kind: "real",
      role: "viewer",
      secondsRemaining: null,
      expired: false,
      expiresAt: null,
    });
  });
  it("reports an expired demo with zero seconds, never negative", () => {
    const [w] = toWorkspaces(
      [row("a", "Old", { kind: "demo", expires_at: "2026-11-01T11:00:00Z" })],
      now,
    );
    expect(w).toMatchObject({ secondsRemaining: 0, expired: true });
  });
  it("hides a real organization's expiry fields even if the row carried one", () => {
    const [w] = toWorkspaces([row("a", "Real", { expires_at: "2000-01-01T00:00:00Z" })], now);
    expect(w).toMatchObject({
      kind: "real",
      expiresAt: null,
      secondsRemaining: null,
      expired: false,
    });
  });
  it("drops rows whose organization RLS hid", () => {
    expect(
      toWorkspaces([{ role: "owner", organizations: null }, row("a", "Mine")], now).map(
        (w) => w.id,
      ),
    ).toEqual(["a"]);
  });
});
