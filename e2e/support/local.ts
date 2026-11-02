import type { BrowserContext } from "@playwright/test";
import { localSupabase, psql } from "../../src/test/local-supabase";

/** Helpers for end-to-end tests: real users on the LOCAL Supabase stack, with their own workspaces, removed afterwards. */
const supabase = localSupabase();
export const PASSWORD = "correct horse battery";
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX"; // Cloudflare's public test token, accepted by the local auth stack
export const BASE = "http://localhost:3111";

export type Person = { id: string; email: string; cookie: { name: string; value: string } };
const created: string[] = [];

const admin = {
  apikey: supabase.secretKey,
  Authorization: `Bearer ${supabase.secretKey}`,
  "Content-Type": "application/json",
};

export async function makeUser(label: string): Promise<Person> {
  const email = `e2e-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const res = await fetch(`${supabase.apiUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const { id } = (await res.json()) as { id: string };
  created.push(id);
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
  // @supabase/ssr keeps the session as base64url JSON under sb-<host first label>-auth-token
  const name = `sb-${new URL(supabase.apiUrl).hostname.split(".")[0]}-auth-token`;
  const value = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  return { id, email, cookie: { name, value } };
}

export async function signIn(context: BrowserContext, person: Person) {
  await context.addCookies([{ ...person.cookie, url: BASE }]);
}

/** A same-origin API call as `person` (the Origin header is what a browser sends). */
export function api(
  person: Person,
  method: string,
  path: string,
  orgId: string | null,
  json?: unknown,
) {
  return fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      cookie: `${person.cookie.name}=${person.cookie.value}`,
      origin: BASE,
      ...(orgId ? { "X-Organization-Id": orgId } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
}

export async function makeWorkspace(owner: Person, name: string): Promise<string> {
  const res = await api(owner, "POST", "/organizations", null, { name });
  return ((await res.json()) as { data: { id: string } }).data.id;
}

export function addMember(orgId: string, person: Person, role: "viewer" | "member" | "admin") {
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${orgId}', '${person.id}', '${role}')`,
  );
}

/** Remember the user behind a browser session (a guest started through the UI) so cleanUp removes them and their workspace. */
export async function trackBrowserUser(context: BrowserContext) {
  const name = `sb-${new URL(supabase.apiUrl).hostname.split(".")[0]}-auth-token`;
  const parts = (await context.cookies())
    .filter((c) => c.name === name || c.name.startsWith(`${name}.`))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (parts.length === 0) return;
  const raw = parts
    .map((c) => c.value)
    .join("")
    .replace(/^base64-/, "");
  const id = (JSON.parse(Buffer.from(raw, "base64url").toString()) as { user?: { id?: string } })
    .user?.id;
  if (id) created.push(id);
}

/** Removes every user this run created, and the workspaces they created (same as the integration tests' cleanup). */
export function cleanUp() {
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const list = ids.map((i) => `'${i}'`).join(",");
  psql(`delete from public.organizations where created_by in (${list})`);
  psql(`delete from auth.users where id in (${list})`);
}
