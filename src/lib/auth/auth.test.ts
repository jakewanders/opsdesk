import { describe, expect, it, vi } from "vitest";
import { AUTH_MESSAGES, classifyAuthError } from "./auth-errors";
import { logIn, signUp } from "./flows";
import { loginSchema, PASSWORD_MAX, signupSchema } from "./schemas";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("keeps in-app paths, with query and hash", () => {
    expect(safeNextPath("/app")).toBe("/app");
    expect(safeNextPath("/app/customers")).toBe("/app/customers");
    expect(safeNextPath("/app/customers?stage=won&page=2#top")).toBe(
      "/app/customers?stage=won&page=2#top",
    );
  });
  it("falls back for missing or non-string values", () => {
    for (const v of [undefined, null, "", 5, {}, ["/app"]])
      expect(safeNextPath(v)).toBe(DEFAULT_AFTER_LOGIN);
  });
  it("rejects open-redirect attempts", () => {
    for (const v of [
      "//evil.example",
      "///evil.example",
      "https://evil.example",
      "http://evil.example/app",
      "javascript:alert(1)",
      "data:text/html,x",
      "/\\evil.example",
      "\\\\evil.example",
      "/app\\..\\evil",
      "/%2F/evil.example",
      "/app/%2e%2e/login",
      "/app/../login",
      "/app//evil.example",
      "/app/%5Cevil",
      "/app\n/x",
      "/app\t",
      " /app",
      "/login",
      "/",
      "/apple",
      "/application/x",
      "app/customers",
    ]) {
      expect(safeNextPath(v), JSON.stringify(v)).toBe(DEFAULT_AFTER_LOGIN);
    }
  });
  it("rejects absurdly long values and honours a custom fallback", () => {
    expect(safeNextPath(`/app/${"a".repeat(3000)}`)).toBe("/app");
    expect(safeNextPath("//x", "/app/settings")).toBe("/app/settings");
  });
});

describe("loginSchema and signupSchema", () => {
  const base = { email: "  Jane@Example.com ", password: "correct horse", captchaToken: "tok" };
  it("normalizes the email and keeps the password exactly as typed", () => {
    const parsed = loginSchema.parse({ ...base, password: "  spaces and CASE  " });
    expect(parsed.email).toBe("jane@example.com");
    expect(parsed.password).toBe("  spaces and CASE  ");
  });
  it("login only requires something in the password field", () => {
    expect(loginSchema.safeParse({ ...base, password: "x" }).success).toBe(true);
    const r = loginSchema.safeParse({ ...base, password: "" });
    expect(r.success).toBe(false);
  });
  it("names each missing field in plain language", () => {
    const r = loginSchema.safeParse({ email: "", password: "", captchaToken: "" });
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(messages).toEqual([
      "Enter your email address.",
      "Enter your password.",
      "Complete the check below.",
    ]);
  });
  it("rejects a malformed email and an HTML-looking one", () => {
    for (const email of ["nope", "a@", "<b>@x.com"])
      expect(loginSchema.safeParse({ ...base, email }).success).toBe(false);
  });
  it("signup enforces password length: 8 characters minimum, 72 bytes maximum", () => {
    expect(signupSchema.safeParse({ ...base, password: "1234567" }).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, password: "12345678" }).success).toBe(true);
    expect(signupSchema.safeParse({ ...base, password: "x".repeat(PASSWORD_MAX) }).success).toBe(
      true,
    );
    expect(
      signupSchema.safeParse({ ...base, password: "x".repeat(PASSWORD_MAX + 1) }).success,
    ).toBe(false);
    // 37 two-byte characters = 74 bytes: under 72 characters but over the bcrypt byte limit
    expect(signupSchema.safeParse({ ...base, password: "é".repeat(37) }).success).toBe(false);
  });
  it("requires the CAPTCHA token", () => {
    expect(signupSchema.safeParse({ ...base, captchaToken: "" }).success).toBe(false);
    expect(signupSchema.safeParse({ email: base.email, password: base.password }).success).toBe(
      false,
    );
  });
});

describe("classifyAuthError", () => {
  it("maps rate limits by status and by code", () => {
    expect(classifyAuthError({ status: 429 })).toBe("rate_limited");
    expect(classifyAuthError({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyAuthError({ code: "over_email_send_rate_limit" })).toBe("rate_limited");
  });
  it("maps CAPTCHA, unconfirmed email, disabled signups, weak passwords", () => {
    expect(classifyAuthError({ code: "captcha_failed", status: 400 })).toBe("captcha");
    expect(classifyAuthError({ code: "email_not_confirmed", status: 400 })).toBe(
      "email_not_confirmed",
    );
    expect(classifyAuthError({ code: "signup_disabled" })).toBe("signups_disabled");
    expect(classifyAuthError({ code: "weak_password", status: 422 })).toBe("weak_password");
  });
  it("collapses every credential failure into one outcome with one message", () => {
    const outcomes = [
      "invalid_credentials",
      "user_not_found",
      "user_already_exists",
      "email_exists",
    ].map((code) => classifyAuthError({ code, status: 400 }));
    expect(new Set(outcomes)).toEqual(new Set(["invalid_credentials"]));
    expect(AUTH_MESSAGES.invalid_credentials).toBe("The email or password is not correct.");
  });
  it("treats unknown and missing errors as the service being unavailable", () => {
    expect(classifyAuthError({ status: 500, code: "unexpected_failure" })).toBe("unavailable");
    expect(classifyAuthError(null)).toBe("unavailable");
  });
});

const input = { email: "a@example.com", password: "correct horse", captchaToken: "tok" };
const client = (overrides: Record<string, unknown>) =>
  ({ auth: overrides }) as unknown as Parameters<typeof logIn>[0];

describe("logIn", () => {
  it("passes the CAPTCHA token and reports success", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({ error: null });
    expect(await logIn(client({ signInWithPassword }), input)).toEqual({
      ok: true,
      next: "signed-in",
    });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "correct horse",
      options: { captchaToken: "tok" },
    });
  });
  it("gives the same message for a wrong password and an unknown email", async () => {
    const wrong = await logIn(
      client({
        signInWithPassword: async () => ({ error: { code: "invalid_credentials", status: 400 } }),
      }),
      input,
    );
    const unknown = await logIn(
      client({
        signInWithPassword: async () => ({ error: { code: "user_not_found", status: 400 } }),
      }),
      input,
    );
    expect(wrong).toEqual(unknown);
    expect(wrong).toMatchObject({ ok: false, message: AUTH_MESSAGES.invalid_credentials });
  });
  it("surfaces rate limits and never throws when the service is down", async () => {
    expect(
      await logIn(client({ signInWithPassword: async () => ({ error: { status: 429 } }) }), input),
    ).toMatchObject({
      failure: "rate_limited",
      message: AUTH_MESSAGES.rate_limited,
    });
    expect(
      await logIn(
        client({
          signInWithPassword: async () => {
            throw new Error("network");
          },
        }),
        input,
      ),
    ).toMatchObject({ ok: false, failure: "unavailable" });
  });
});

describe("signUp", () => {
  const redirect = "http://localhost:3000/auth/callback";
  it("sends the confirmation to the allowlisted callback with the CAPTCHA token", async () => {
    const fn = vi.fn().mockResolvedValue({ data: { session: null }, error: null });
    expect(await signUp(client({ signUp: fn }), input, redirect)).toEqual({
      ok: true,
      next: "check-email",
    });
    expect(fn).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "correct horse",
      options: { captchaToken: "tok", emailRedirectTo: redirect },
    });
  });
  it("signs the user in when confirmation is off and a session comes back", async () => {
    const r = await signUp(
      client({ signUp: async () => ({ data: { session: {} }, error: null }) }),
      input,
      redirect,
    );
    expect(r).toEqual({ ok: true, next: "signed-in" });
  });
  it("answers an already-registered address exactly like a new one", async () => {
    for (const code of ["user_already_exists", "email_exists"]) {
      const r = await signUp(
        client({ signUp: async () => ({ data: {}, error: { code, status: 422 } }) }),
        input,
        redirect,
      );
      expect(r).toEqual({ ok: true, next: "check-email" });
    }
  });
  it("still reports real problems: CAPTCHA, weak password, rate limit, other 422s", async () => {
    const run = (error: object) =>
      signUp(client({ signUp: async () => ({ data: {}, error }) }), input, redirect);
    expect(await run({ code: "captcha_failed", status: 400 })).toMatchObject({
      failure: "captcha",
    });
    expect(await run({ code: "weak_password", status: 422 })).toMatchObject({
      failure: "weak_password",
    });
    expect(await run({ status: 429 })).toMatchObject({ failure: "rate_limited" });
    // a validation failure must not be swallowed as "check your email"
    expect(await run({ code: "validation_failed", status: 422 })).toMatchObject({ ok: false });
  });
});
