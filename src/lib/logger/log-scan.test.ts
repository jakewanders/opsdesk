import { describe, expect, it } from "vitest";
import { requestIdsLogged, scanLogLines } from "../../../scripts/lib/log-scan.mjs";

const line = (o: object, prefix = "[WebServer] ") => `${prefix}${JSON.stringify(o)}`;
const ok = {
  event: "api.request",
  requestId: "6be1d638-e081-4e5b-b76e-097a67077956",
  route: "/api/v1/customers/:id",
  status: 200,
  durationMs: 4,
  userId: "791592b6-7c99-41a4-91f9-ddf16f4477d4",
  level: "info",
  ts: "2026-11-03T10:16:32.496Z",
};

describe("log scan [SIT-275]", () => {
  it("passes ordinary request lines and counts them; ignores non-JSON output", () => {
    const r = scanLogLines([
      line(ok),
      "  ✓ 1 [desktop] › some test (1s)",
      "",
      line({ ...ok, errorCode: "OD404" }, ""),
    ]);
    expect(r).toEqual({ jsonLines: 2, findings: [] });
  });
  it.each([
    ["a JWT", { token: "[redacted]", note: "eyJhbGciOi.eyJzdWIiOiIx.abcDEF123456" }, "jwt"],
    ["a bearer token", { header: "Bearer abcdefgh12345678" }, "bearer token"],
    ["a secret key", { msg: "key sb_secret_abcdefghijk" }, "provider key"],
    ["the auth cookie name", { msg: "sb-127-auth-token.0" }, "auth cookie name"],
    ["an e-mail address", { msg: "from ann@example.com" }, "e-mail address"],
    ["a URL password", { msg: "postgres://u:hunter2@db:5432/x" }, "password in a URL"],
    ["SQL text", { msg: "select * from customers where id = 1" }, "SQL text"],
    [
      "database internals",
      { msg: 'duplicate key value violates unique constraint "x"' },
      "database internals",
    ],
    [
      "a refused connection detail",
      { msg: "TypeError: fetch failed" },
      "connection refusal detail",
    ],
    ["a long opaque string", { msg: "x".repeat(10) + "a1".repeat(25) }, "long opaque string"],
    [
      "a note kept in the clear",
      { notes: "Call back about the leaking roof" },
      "unredacted sensitive key",
    ],
    [
      "a password field kept in the clear",
      { user: { password: "hunter2" } },
      "unredacted sensitive key",
    ],
  ])("finds %s", (_label, extra, rule) => {
    const r = scanLogLines([line({ ...ok, ...extra })]);
    expect(r.findings.map((f) => f.rule)).toContain(rule);
  });
  it("accepts redacted values and identifier keys", () => {
    const r = scanLogLines([
      line({
        ...ok,
        token: "[redacted]",
        notes: "[redacted]",
        email: "[email]",
        userId: ok.userId,
        orgId: ok.userId,
      }),
    ]);
    expect(r.findings).toEqual([]);
  });
  it("never prints the offending value in full", () => {
    const [f] = scanLogLines([line({ ...ok, msg: "Bearer abcdefghijklmnop1234567890" })]).findings;
    expect(JSON.stringify(f)).not.toContain("abcdefghijklmnop1234567890");
  });
  it("collects the request ids that were logged", () => {
    expect([...requestIdsLogged([line(ok), "noise"])]).toEqual([ok.requestId]);
  });
});
