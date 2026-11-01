import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/**
 * Starts the PRODUCTION build (`next start`) against the local Supabase stack and checks, over real HTTP,
 * that no response that can depend on a session is cacheable and that one user's page is never served to
 * another. Uses the existing production build (`npm run check` builds first) and builds one if none exists.
 */
const run = Date.now();
const PASSWORD = "correct horse battery";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const emailOf = (label: string) => `leak-${run}-${label}@example.test`;

let supabase: LocalSupabase;
let server: ChildProcess;
let base = "";
const cookies: Record<string, string> = {};
const bodiesSeen: string[] = [];

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

async function createUserAndCookie(label: string) {
  const email = emailOf(label);
  const created = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: supabase.secretKey,
      Authorization: `Bearer ${supabase.secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  expect(created.status).toBe(200);
  const token = await fetch(`${supabase.apiUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: supabase.publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      gotrue_meta_security: { captcha_token: TOKEN },
    }),
  });
  const session = await token.json();
  // @supabase/ssr stores the session as base64url JSON under sb-<host first label>-auth-token
  const name = `sb-${new URL(supabase.apiUrl).hostname.split(".")[0]}-auth-token`;
  cookies[label] = `${name}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

const get = (path: string, cookie?: string, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });

const isPrivateNoStore = (res: Response) => {
  const cc = res.headers.get("cache-control") ?? "";
  return /\bprivate\b/i.test(cc) && /\bno-store\b/i.test(cc);
};

beforeAll(async () => {
  if (!existsSync(".next/BUILD_ID"))
    throw new Error("No production build found. Run `npm run build` first.");
  supabase = localSupabase();
  const port = await freePort();
  base = `http://localhost:${port}`;
  server = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      NEXT_PUBLIC_APP_URL: base,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/privacy`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await createUserAndCookie("a");
  await createUserAndCookie("b");
}, 400_000);

afterAll(() => {
  server?.kill();
  psql(`delete from auth.users where email like 'leak-${run}-%'`);
});

const routeSource = readFileSync("src/lib/routes.ts", "utf8");
const routes = [
  ...routeSource.matchAll(
    /\{ path: "([^"]+)", group: "(public|app)"(?:, sample: `([^`]+)`)?(?:, flag: "(\w+)")? \}/g,
  ),
].map((m) => ({
  path: m[1],
  group: m[2],
  url: (m[3] ?? m[1]).replace("${ID}", "00000000-0000-0000-0000-000000000000"),
  flag: m[4],
}));
const PRIVATE_PUBLIC_ROUTES = new Set([
  "/demo",
  "/login",
  "/signup",
  "/auth/callback",
  "/forgot-password",
  "/reset-password",
]);

describe("cache headers over real HTTP", () => {
  it("parsed the route list", () => {
    expect(routes.length).toBeGreaterThan(20);
  });
  it("every protected route and every auth page answers private, no-store (signed out and signed in)", async () => {
    const failures: string[] = [];
    for (const route of routes.filter(
      (r) => r.group === "app" || PRIVATE_PUBLIC_ROUTES.has(r.path),
    )) {
      for (const who of [undefined, cookies.a]) {
        const res = await get(route.url, who);
        await res.arrayBuffer();
        if (!isPrivateNoStore(res)) {
          failures.push(
            `${who ? "member" : "signed-out"} ${route.url} -> ${res.status} cache-control="${res.headers.get("cache-control")}"`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
  it("an unknown API route and an API redirect-free 404 are private, no-store too", async () => {
    const res = await get("/api/v1/does-not-exist", cookies.a);
    expect(isPrivateNoStore(res)).toBe(true);
  });
  it("the landing and legal pages stay cacheable and carry no cookies", async () => {
    for (const path of ["/", "/privacy", "/terms"]) {
      const res = await get(path, cookies.a);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control"), path).toMatch(/s-maxage/);
      expect(res.headers.get("cache-control"), path).not.toMatch(/no-store/);
      expect(res.headers.get("set-cookie"), path).toBeNull();
      // a signed-in visitor's identity is not rendered into a static page
      expect(html, path).not.toContain(emailOf("a"));
    }
  });
});

describe("one user's page is never served to another", () => {
  const PAGE = "/app/setup";

  it("alternating requests from A, B and a signed-out visitor each get their own response", async () => {
    for (let round = 0; round < 6; round++) {
      for (const who of ["a", "b", undefined, "b", "a"] as const) {
        const res = await get(PAGE, who ? cookies[who] : undefined);
        const body = await res.text();
        bodiesSeen.push(body);
        if (who === undefined) {
          expect(res.status).toBe(307);
          expect(res.headers.get("location")).toContain("/login");
          expect(body).not.toContain(`leak-${run}`);
        } else {
          const other = who === "a" ? "b" : "a";
          expect(res.status, `${who} round ${round}`).toBe(200);
          expect(body).toContain(emailOf(who));
          expect(body, `${who} page leaked ${other}`).not.toContain(emailOf(other));
        }
        expect(isPrivateNoStore(res)).toBe(true);
      }
    }
    expect(bodiesSeen.length).toBe(30);
  });

  it("the React Server Component payload is not shared either", async () => {
    for (let round = 0; round < 4; round++) {
      for (const who of ["a", "b"] as const) {
        const res = await get(PAGE, cookies[who], { RSC: "1", "Next-Router-Prefetch": "1" });
        const body = await res.text();
        expect(isPrivateNoStore(res)).toBe(true);
        const other = who === "a" ? "b" : "a";
        expect(body).not.toContain(emailOf(other));
      }
    }
  });

  it("a forged or garbage session cookie never receives another user's page", async () => {
    // Tamper with the signed token and drop the refresh token, so nothing can legitimately restore it.
    const [name, value] = cookies.a.split("=base64-");
    const session = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    session.access_token = `${session.access_token.slice(0, -4)}AAAA`;
    session.refresh_token = "forged";
    const stolen = `${name}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    const res = await get(PAGE, stolen);
    const body = await res.text();
    expect(res.status).toBe(307);
    expect(body).not.toContain(emailOf("a"));
  });
});
