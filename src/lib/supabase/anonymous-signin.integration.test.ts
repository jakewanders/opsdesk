import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

// Cloudflare's documented dummy Turnstile token. The local dummy secret (supabase/config.toml)
// accepts any non-empty token. https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let supabase: LocalSupabase;
const createdUserIds: string[] = [];

const userCount = () => Number(psql("select count(*) from auth.users"));

async function signInAnonymously(captchaToken?: string | null) {
  const body =
    captchaToken === undefined ? {} : { gotrue_meta_security: { captcha_token: captchaToken } };
  const response = await fetch(`${supabase.apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: supabase.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeAll(() => {
  supabase = localSupabase();
});

afterAll(() => {
  // Leave the local database as the tests found it.
  for (const id of createdUserIds) psql(`delete from auth.users where id = '${id}'`);
});

describe("anonymous sign-in with Turnstile CAPTCHA (local Supabase)", () => {
  it("rejects a request with no CAPTCHA token and creates no user", async () => {
    const before = userCount();
    const { status, json } = await signInAnonymously();
    expect(status).toBe(400);
    expect(json.error_code).toBe("captcha_failed");
    expect(userCount()).toBe(before);
  });

  it("rejects an empty CAPTCHA token and creates no user", async () => {
    const before = userCount();
    const { status, json } = await signInAnonymously("");
    expect(status).toBe(400);
    expect(json.error_code).toBe("captcha_failed");
    expect(userCount()).toBe(before);
  });

  it("accepts a valid Turnstile test token and creates exactly one anonymous user with a profile", async () => {
    const before = userCount();
    const { status, json } = await signInAnonymously(DUMMY_TOKEN);
    expect(status).toBe(200);
    const user = json.user as { id: string; is_anonymous: boolean; email?: string };
    createdUserIds.push(user.id);
    expect(user.is_anonymous).toBe(true);
    expect(typeof json.access_token).toBe("string");
    expect(userCount()).toBe(before + 1);
    // The auth trigger from SIT-167 ran against the real Auth service.
    expect(psql(`select display_name from public.profiles where id = '${user.id}'`)).toBe(
      "Demo User",
    );
  });
});
