import { describe, expect, it } from "vitest";
import { isSensitiveKey, redact, redactString, REDACTED } from "./redact";

const JWT =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6ImI4MTI2OWYxIn0.eyJzdWIiOiJkMGQ1YTlhYyIsImV4cCI6MTc5MzU4NjEyMH0.Sj5v1Yn0jg2pxiWkuQCCVePHp6SN5daU9EatIRixueNz3oRkbqI2OfRHGFxjqt46hnSYwetzuTQpsmOOUmKwA";

describe("redaction by key", () => {
  it.each([
    "password",
    "newPassword",
    "token",
    "access_token",
    "refreshToken",
    "authorization",
    "Authorization",
    "cookie",
    "set-cookie",
    "apiKey",
    "api_key",
    "SUPABASE_SECRET_KEY",
    "invitationToken",
    "invite_code",
    "sessionCookie",
    "captchaToken",
    "signature",
    "jwt",
    "notes",
    "note",
    "description",
    "body",
    "comment",
    "content",
    "email",
    "phone",
    "address",
  ])("%s is redacted", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
    expect(redact({ [key]: "value" })).toEqual({ [key]: REDACTED });
  });

  it.each([
    "requestId",
    "orgId",
    "userId",
    "route",
    "status",
    "durationMs",
    "count",
    "errorCode",
    "organizationId",
  ])("%s is kept", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it("redacts nested keys at any depth, inside arrays too", () => {
    const out = redact({
      a: { b: { c: { password: "hunter2", ok: 1 } } },
      list: [{ token: "t" }, { fine: true }],
      headers: { Authorization: "Bearer abc", "x-request-id": "r1" },
    });
    expect(out).toEqual({
      a: { b: { c: { password: REDACTED, ok: 1 } } },
      list: [{ token: REDACTED }, { fine: true }],
      headers: { Authorization: REDACTED, "x-request-id": "r1" },
    });
  });

  it("redacts a sensitive key even when its value is an object", () => {
    expect(redact({ notes: { a: 1 }, cookie: ["x"] })).toEqual({
      notes: REDACTED,
      cookie: REDACTED,
    });
  });
});

describe("redaction by pattern (values)", () => {
  it("JWTs, bearer tokens and basic auth", () => {
    expect(redactString(`session ${JWT} end`)).not.toContain("eyJ");
    expect(redactString("Authorization: Bearer abcDEF123456.xyz")).not.toContain("abcDEF");
    expect(redactString("Basic dXNlcjpwYXNzd29yZA==")).toBe(`Basic ${REDACTED}`);
  });
  it("a short JWT (no segment long enough for the opaque-token rule) is still caught by the JWT rule", () => {
    const short = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcDEF123xyz-_ghijk";
    expect(redactString(`t=${short}`)).not.toContain("eyJ");
    expect(redactString(`seen ${short} here`)).toBe(`seen ${REDACTED} here`);
  });
  it("provider key prefixes", () => {
    for (const key of [
      "sb_secret_AbCdEf1234567890xyz",
      "sk_live_51Habcdefghijklmnop",
      "sk_test_abcdefghijklmnop12",
      "whsec_abcdefghijklmnop12",
      "re_AbCdEfGhIjKlMnOp",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "xoxb-123456789012-abcdefghijkl",
      ["0x", "4AAAAAAAabcdefghijklmnopqrstuv"].join(""),
    ]) {
      expect(redactString(`key is ${key} ok`), key).not.toContain(key.slice(4, 14));
    }
  });
  it("name=value pairs with secret-looking names, as in query strings, headers and cookies", () => {
    expect(redactString("GET /x?access_token=abc123&page=2")).toBe(
      `GET /x?access_token=${REDACTED}&page=2`,
    );
    expect(redactString("cookie sb-local-auth-token=base64-abcdef; theme=dark")).toContain(
      `sb-local-auth-token=${REDACTED}`,
    );
    expect(redactString("password: hunter2 and more")).toContain(`password=${REDACTED}`);
  });
  it("connection-string passwords", () => {
    expect(redactString("postgres://postgres:supersecret@db.example.test:5432/postgres")).toBe(
      `postgres://postgres:${REDACTED}@db.example.test:5432/postgres`,
    );
  });
  it("e-mail addresses inside text", () => {
    expect(redactString("user pat.smith+x@example.co.uk failed")).toBe("user [email] failed");
  });
  it("long opaque credentials, but not UUIDs or ordinary words", () => {
    const opaque = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0uV";
    expect(redactString(`id ${opaque}`)).toBe(`id ${REDACTED}`);
    const uuid = "d0d5a9ac-a418-46bf-9e55-483246054f52";
    expect(redactString(`org ${uuid}`)).toBe(`org ${uuid}`);
    expect(redactString("a perfectly ordinary sentence with no secrets")).toBe(
      "a perfectly ordinary sentence with no secrets",
    );
  });
  it("applies to strings nested in objects and arrays", () => {
    const out = JSON.stringify(
      redact({
        message: `bad ${JWT}`,
        items: [`Bearer abcdefghijkl`],
        deep: { x: { y: "me@example.test" } },
      }),
    );
    expect(out).not.toContain("eyJ");
    expect(out).not.toContain("abcdefghijkl");
    expect(out).not.toContain("me@example.test");
  });
});

describe("bounds and shapes", () => {
  it("truncates long strings, long arrays and deep objects", () => {
    expect(redactString("x".repeat(600))).toHaveLength(500 + "…[truncated]".length);
    expect((redact(Array.from({ length: 50 }, (_, i) => i)) as unknown[]).length).toBe(21);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(JSON.stringify(redact(deep))).toContain("[depth limit]");
  });
  it("cuts cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[circular]" });
  });
  it("turns an Error into name, code and a redacted message, with no stack", () => {
    const err = Object.assign(new Error(`failed for me@example.test with ${JWT}`), {
      code: "23505",
    });
    const out = redact({ error: err }) as { error: Record<string, unknown> };
    expect(out.error).toMatchObject({ name: "Error", code: "23505" });
    expect(JSON.stringify(out)).not.toContain("me@example.test");
    expect(JSON.stringify(out)).not.toContain("eyJ");
    expect(JSON.stringify(out)).not.toContain("stack");
  });
  it("handles dates, bigint, null, undefined, functions and symbols without throwing", () => {
    expect(
      redact({
        d: new Date("2026-11-02T00:00:00Z"),
        n: BigInt(10),
        z: null,
        u: undefined,
        f: () => 1,
        s: Symbol("x"),
      }),
    ).toEqual({
      d: "2026-11-02T00:00:00.000Z",
      n: "10",
      z: null,
      u: undefined,
      f: undefined,
      s: undefined,
    });
  });
});
