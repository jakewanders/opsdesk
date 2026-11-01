import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { AUTH_MESSAGES } from "./auth-errors";
import { logIn, signUp } from "./flows";

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
