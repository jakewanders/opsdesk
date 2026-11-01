import { createServerClient } from "@supabase/ssr";
import { createClient as createJsClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";
import { createServerSupabase, type CookieJar } from "./create-server-client";
import { resolveUser } from "./resolve-user";

// Cloudflare's documented dummy Turnstile token; the local dummy secret accepts it (SIT-168).
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

let supabase: LocalSupabase;
const createdUserIds: string[] = [];

type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  token_type: string;
  user: { id: string; is_anonymous: boolean };
};

async function signInAnonymously(): Promise<Session> {
  const response = await fetch(`${supabase.apiUrl}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: supabase.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ gotrue_meta_security: { captcha_token: DUMMY_TOKEN } }),
  });
  expect(response.status).toBe(200);
  const session = (await response.json()) as Session;
  createdUserIds.push(session.user.id);
  return session;
}

/** An in-memory cookie store that behaves like a browser's, for server-side clients. */
function makeJar(): CookieJar & { all(): { name: string; value: string }[] } {
  const cookies = new Map<string, string>();
  return {
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    set: (name, value) => void cookies.set(name, value),
    all: () => [...cookies].map(([name, value]) => ({ name, value })),
  };
}

const env = () => ({ url: supabase.apiUrl, key: supabase.publishableKey });

/** A server client whose cookie jar holds `session`, as after a real sign-in. */
async function clientWithSession(session: Session) {
  const jar = makeJar();
  const client = createServerSupabase(jar, env());
  const { error } = await client.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  expect(error).toBeNull();
  return { jar, client };
}

let userA: Session;
let userB: Session;

beforeAll(async () => {
  supabase = localSupabase();
  userA = await signInAnonymously();
  userB = await signInAnonymously();
});

afterAll(() => {
  for (const id of createdUserIds) psql(`delete from auth.users where id = '${id}'`);
});

/** A plain client with no session, used to verify a given token. */
const verifier = () =>
  createJsClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

describe("resolveUser: verifies the token with Supabase Auth", () => {
  it("returns the user, including is_anonymous, for a valid token", async () => {
    const user = await resolveUser(verifier(), userA.access_token);
    expect(user).toEqual({ id: userA.user.id, email: null, isAnonymous: true });
  });

  it("returns null for a tampered token (signature changed)", async () => {
    const [header, payload, signature] = userA.access_token.split(".");
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(await resolveUser(verifier(), `${header}.${payload}.${flipped}`)).toBeNull();
  });

  it("returns null for a token whose payload was edited to claim another user", async () => {
    const [header, payload, signature] = userA.access_token.split(".");
    const edited = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    edited.sub = userB.user.id;
    const forged = `${header}.${Buffer.from(JSON.stringify(edited)).toString("base64url")}.${signature}`;
    expect(await resolveUser(verifier(), forged)).toBeNull();
  });

  it("returns null for an expired token", async () => {
    // Sign a structurally valid, expired token with the project's legacy JWT secret. Whether the
    // service rejects it as expired or as unverifiable, it must never resolve to a user.
    const { createHmac } = await import("node:crypto");
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const header = b64({ alg: "HS256", typ: "JWT" });
    const now = Math.floor(Date.now() / 1000);
    const payload = b64({
      sub: userA.user.id,
      role: "authenticated",
      aud: "authenticated",
      is_anonymous: true,
      iat: now - 7200,
      exp: now - 3600,
    });
    const signature = createHmac(
      "sha256",
      "super-secret-jwt-token-with-at-least-32-characters-long",
    )
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(await resolveUser(verifier(), `${header}.${payload}.${signature}`)).toBeNull();
  });

  it("returns null for garbage and for no session at all", async () => {
    expect(await resolveUser(verifier(), "not-a-jwt")).toBeNull();
    expect(await resolveUser(verifier())).toBeNull();
  });

  it("returns null instead of throwing when the Auth service is unreachable", async () => {
    const unreachable = createJsClient("http://127.0.0.1:9", supabase.publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(await resolveUser(unreachable, userA.access_token)).toBeNull();
  });
});

describe("server client: acts as the signed-in user under RLS", () => {
  it("reads only the caller's own profile", async () => {
    const { client } = await clientWithSession(userA);
    const own = await client.from("profiles").select("id, display_name");
    expect(own.error).toBeNull();
    expect(own.data).toEqual([{ id: userA.user.id, display_name: "Demo User" }]);

    const other = await client.from("profiles").select("id").eq("id", userB.user.id);
    expect(other.data).toEqual([]);
  });

  it("resolves the user from its own session cookies", async () => {
    const { client } = await clientWithSession(userB);
    expect(await resolveUser(client)).toEqual({
      id: userB.user.id,
      email: null,
      isAnonymous: true,
    });
  });

  it("is signed out with no cookies, and cannot read profiles", async () => {
    const client = createServerSupabase(makeJar(), env());
    expect(await resolveUser(client)).toBeNull();
    const { error } = await client.from("profiles").select("id");
    expect(error?.code).toBe("42501"); // permission denied for the anon role
  });
});

describe("proxy session refresh", () => {
  // The proxy imports public env through the validated reader; give it the local values.
  async function load() {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", supabase.apiUrl);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", supabase.publishableKey);
    return import("./middleware");
  }

  it("refreshes an expired access token and forwards new cookies with no-store headers", async () => {
    const { updateSession } = await load();
    const { jar } = await clientWithSession(userA);
    const [cookie] = jar.all();
    expect(jar.all()).toHaveLength(1); // the session fits in one (unchunked) cookie
    expect(cookie.name).toMatch(/^sb-.*-auth-token$/);

    // Rewrite the stored session so the access token is past its expiry, as it would be an
    // hour later, keeping the valid refresh token.
    const stored = JSON.parse(
      Buffer.from(cookie.value.replace(/^base64-/, ""), "base64url").toString(),
    ) as Session;
    stored.expires_at = Math.floor(Date.now() / 1000) - 60;
    const expiredCookie = `base64-${Buffer.from(JSON.stringify(stored)).toString("base64url")}`;

    const request = new NextRequest("http://localhost:3000/app", {
      headers: { cookie: `${cookie.name}=${expiredCookie}` },
    });
    const { response, user } = await updateSession(request);

    expect(user).toEqual({ id: userA.user.id, email: null, isAnonymous: true });
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(cookie.name);
    expect(setCookie).not.toContain(expiredCookie);
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie.toLowerCase()).not.toContain("domain=");
    expect(response.headers.get("cache-control")).toMatch(/no-store/);

    // The page rendered next sees the refreshed session, not the expired one.
    expect(request.cookies.get(cookie.name)?.value).not.toBe(expiredCookie);
    vi.unstubAllEnvs();
  });

  it("passes a request with no session through, signed out and without cookies", async () => {
    const { updateSession } = await load();
    const request = new NextRequest("http://localhost:3000/app");
    const { response, user } = await updateSession(request);
    expect(user).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("server client factory (cookie writes)", () => {
  it("writes a refreshed session back to the cookie jar", async () => {
    const { jar, client } = await clientWithSession(userA);
    expect(jar.all().length).toBeGreaterThan(0);
    // A server client created straight from createServerClient behaves the same way.
    expect(typeof createServerClient).toBe("function");
    expect(await resolveUser(client)).not.toBeNull();
  });
});
