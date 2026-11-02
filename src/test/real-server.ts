import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { expect } from "vitest";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/**
 * Starts the PRODUCTION build (`next start`) against the LOCAL Supabase stack, with helpers to create real and guest
 * users and send requests as them (session cookie, same-origin `Origin`). Builds first when no build exists.
 */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const PASSWORD = "correct horse battery";

export type Actor = { id: string; email: string | null; cookie: string; isAnonymous: boolean };

export class RealServer {
  /** Point the app at another Supabase URL (for example a closed port, to simulate an outage). Users cannot be created then. */
  constructor(private readonly options: { supabaseUrl?: string } = {}) {}

  supabase!: LocalSupabase;
  base = "";
  private child?: ChildProcess;
  private created: string[] = [];

  async start(): Promise<void> {
    this.supabase = localSupabase();
    if (!existsSync(".next/BUILD_ID")) {
      await new Promise<void>((resolve, reject) => {
        const build = spawn("node_modules/.bin/next", ["build"], {
          stdio: "ignore",
          env: process.env,
        });
        build.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`next build failed (${code})`)),
        );
      });
    }
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.listen(0, () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
      s.on("error", reject);
    });
    this.base = `http://localhost:${port}`;
    this.child = spawn("node_modules/.bin/next", ["start", "-p", String(port)], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_PUBLIC_SUPABASE_URL: this.options.supabaseUrl ?? this.supabase.apiUrl,
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: this.supabase.publishableKey,
        NEXT_PUBLIC_APP_URL: this.base,
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
      stdio: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${this.base}/privacy`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("the production server did not start");
  }

  private cookieFrom(session: unknown): string {
    // @supabase/ssr stores the session as base64url JSON under sb-<host first label>-auth-token
    const name = `sb-${new URL(this.supabase.apiUrl).hostname.split(".")[0]}-auth-token`;
    return `${name}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  }

  async member(label: string): Promise<Actor> {
    const email = `api-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
    const created = await fetch(`${this.supabase.apiUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: {
        apikey: this.supabase.secretKey,
        Authorization: `Bearer ${this.supabase.secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    });
    const { id } = (await created.json()) as { id: string };
    this.created.push(id);
    const token = await fetch(`${this.supabase.apiUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: this.supabase.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        gotrue_meta_security: { captcha_token: TOKEN },
      }),
    });
    expect(token.status).toBe(200);
    return { id, email, cookie: this.cookieFrom(await token.json()), isAnonymous: false };
  }

  async guest(): Promise<Actor> {
    const res = await fetch(`${this.supabase.apiUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: this.supabase.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ gotrue_meta_security: { captcha_token: TOKEN } }),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as { user: { id: string } };
    this.created.push(session.user.id);
    return {
      id: session.user.id,
      email: null,
      cookie: this.cookieFrom(session),
      isAnonymous: true,
    };
  }

  /** Sends a request as `actor` (or signed out). Mutations carry the same-origin `Origin` header the browser would. */
  request(
    path: string,
    actor?: Actor | null,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const method = init.method ?? (init.json === undefined ? "GET" : "POST");
    return fetch(this.base + path, {
      method,
      redirect: "manual",
      headers: {
        ...(actor ? { cookie: actor.cookie } : {}),
        ...(method !== "GET" ? { origin: this.base } : {}),
        ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  }

  stop(): void {
    this.child?.kill();
    if (this.created.length) {
      const list = this.created.map((i) => `'${i}'`).join(",");
      psql(`delete from public.organizations where created_by in (${list})`);
      psql(`delete from auth.users where id in (${list})`);
    }
  }
}
