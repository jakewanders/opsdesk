import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { AUTH_MESSAGES } from "./auth-errors";
import { logIn, requestPasswordReset, setNewPassword, signUp } from "./flows";

// Cloudflare's dummy token: the local dummy secret accepts any non-empty value.
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const REDIRECT = "http://localhost:3000/auth/callback";
const run = Date.now();
const emailOf = (label: string) => `auth-it-${run}-${label}@example.test`;
const PASSWORD = "correct horse battery";

let supabase: LocalSupabase;
const client = () =>
  createClient(supabase.apiUrl, supabase.publishableKey, { auth: { persistSession: false } });

beforeAll(() => {
  supabase = localSupabase();
});
afterAll(() => {
  psql(`delete from auth.users where email like 'auth-it-${run}-%'`);
});

describe("sign-up and sign-in against local Supabase Auth", () => {
  it("sign-up with confirmation on creates the user without a session", async () => {
    const result = await signUp(
      client(),
      { email: emailOf("a"), password: PASSWORD, captchaToken: TOKEN },
      REDIRECT,
    );
    expect(result).toEqual({ ok: true, next: "check-email" });
    expect(
      psql(`select email_confirmed_at is null from auth.users where email = '${emailOf("a")}'`),
    ).toBe("t");
  });

  it("signing up again with the same address gives the same answer and creates no second user", async () => {
    // Supabase throttles a second confirmation email for the same address (max_frequency, 1s locally).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await signUp(
      client(),
      { email: emailOf("a"), password: "different password 2", captchaToken: TOKEN },
      REDIRECT,
    );
    expect(result).toEqual({ ok: true, next: "check-email" });
    expect(psql(`select count(*) from auth.users where email = '${emailOf("a")}'`)).toBe("1");
  });

  it("an unconfirmed account cannot sign in, and says to confirm the email", async () => {
    const result = await logIn(client(), {
      email: emailOf("a"),
      password: PASSWORD,
      captchaToken: TOKEN,
    });
    expect(result).toMatchObject({ ok: false, failure: "email_not_confirmed" });
  });

  it("after confirmation the right password signs in", async () => {
    psql(`update auth.users set email_confirmed_at = now() where email = '${emailOf("a")}'`);
    expect(
      await logIn(client(), { email: emailOf("a"), password: PASSWORD, captchaToken: TOKEN }),
    ).toEqual({
      ok: true,
      next: "signed-in",
    });
  });

  it("a wrong password and an unknown email are indistinguishable", async () => {
    const wrong = await logIn(client(), {
      email: emailOf("a"),
      password: "not the password",
      captchaToken: TOKEN,
    });
    const unknown = await logIn(client(), {
      email: emailOf("nobody"),
      password: "not the password",
      captchaToken: TOKEN,
    });
    expect(wrong).toEqual(unknown);
    expect(wrong).toMatchObject({
      ok: false,
      failure: "invalid_credentials",
      message: AUTH_MESSAGES.invalid_credentials,
    });
  });

  it("the server requires a CAPTCHA token on sign-in and sign-up", async () => {
    expect(
      await logIn(client(), { email: emailOf("a"), password: PASSWORD, captchaToken: "" }),
    ).toMatchObject({
      ok: false,
      failure: "captcha",
    });
    expect(
      await signUp(
        client(),
        { email: emailOf("b"), password: PASSWORD, captchaToken: "" },
        REDIRECT,
      ),
    ).toMatchObject({
      ok: false,
      failure: "captcha",
    });
    expect(psql(`select count(*) from auth.users where email = '${emailOf("b")}'`)).toBe("0");
  });

  it("the server rejects a password under the configured minimum", async () => {
    const result = await signUp(
      client(),
      { email: emailOf("c"), password: "short", captchaToken: TOKEN },
      REDIRECT,
    );
    expect(result).toMatchObject({ ok: false });
    expect(psql(`select count(*) from auth.users where email = '${emailOf("c")}'`)).toBe("0");
  });
});

describe("password reset against local Supabase Auth", () => {
  const REDIRECT_RESET = "http://localhost:3000/auth/callback?next=/reset-password";

  it("answers a reset request the same for an existing and an unknown address", async () => {
    const created = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: supabase.secretKey,
        Authorization: `Bearer ${supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: emailOf("reset"), password: PASSWORD, email_confirm: true }),
    });
    expect(created.status).toBe(200);
    const known = await requestPasswordReset(
      client(),
      { email: emailOf("reset"), captchaToken: TOKEN },
      REDIRECT_RESET,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const unknown = await requestPasswordReset(
      client(),
      { email: emailOf("ghost"), captchaToken: TOKEN },
      REDIRECT_RESET,
    );
    expect(known).toEqual({ ok: true, next: "check-email" });
    expect(unknown).toEqual(known);
  });

  it("requires the CAPTCHA token", async () => {
    expect(
      await requestPasswordReset(
        client(),
        { email: emailOf("reset"), captchaToken: "" },
        REDIRECT_RESET,
      ),
    ).toMatchObject({ ok: false, failure: "captcha" });
  });

  it("sets a new password, rejects the old one, and signs the other sessions out", async () => {
    const a = client();
    const b = client();
    for (const c of [a, b]) {
      expect(
        await logIn(c, { email: emailOf("reset"), password: PASSWORD, captchaToken: TOKEN }),
      ).toMatchObject({ ok: true });
    }
    expect((await b.auth.getUser()).data.user?.email).toBe(emailOf("reset"));

    expect(await setNewPassword(a, "a brand new password")).toEqual({
      ok: true,
      next: "signed-in",
    });

    expect(
      await logIn(client(), { email: emailOf("reset"), password: PASSWORD, captchaToken: TOKEN }),
    ).toMatchObject({ ok: false, failure: "invalid_credentials" });
    expect(
      await logIn(client(), {
        email: emailOf("reset"),
        password: "a brand new password",
        captchaToken: TOKEN,
      }),
    ).toMatchObject({ ok: true });
    // the other device's session was revoked; the one that changed the password still works
    expect((await b.auth.getUser()).data.user).toBeNull();
    expect((await a.auth.getUser()).data.user?.email).toBe(emailOf("reset"));
  });

  it("refuses to set a password without a session, and a reused password", async () => {
    expect(await setNewPassword(client(), "whatever long password")).toMatchObject({ ok: false });
    const c = client();
    await logIn(c, {
      email: emailOf("reset"),
      password: "a brand new password",
      captchaToken: TOKEN,
    });
    expect(await setNewPassword(c, "a brand new password")).toMatchObject({
      ok: false,
      failure: "same_password",
    });
  });
});
