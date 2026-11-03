import { spawnSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import handler from "../../../netlify/functions/cleanup-demo.mts";
import { localSupabase, psql, type LocalSupabase } from "@/test/local-supabase";

/**
 * [SIT-213] The two entry points to the cleanup core against the LOCAL stack: the Netlify scheduled function's handler (called
 * directly) and `npm run demo:cleanup` (run as a child process). An expired demo is purged and an active one is left; a refusal
 * happens before any network call; no secret appears in any output.
 */
const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
let supabase: LocalSupabase;
const created: string[] = [];
type Guest = { id: string; org: string };

async function guest(): Promise<Guest> {
  const c = createClient(supabase.apiUrl, supabase.publishableKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.signInAnonymously({ options: { captchaToken: TOKEN } });
  expect(error).toBeNull();
  created.push(data.user!.id);
  const boot = await c.rpc("bootstrap_demo_workspace");
  expect(boot.error).toBeNull();
  return { id: data.user!.id, org: (boot.data as { organization_id: string }).organization_id };
}
const expire = (g: Guest) =>
  psql(
    `update public.organizations set expires_at = now() - interval '1 minute' where id = '${g.org}'`,
  );
const orgExists = (id: string) =>
  Number(psql(`select count(*) from public.organizations where id = '${id}'`)) === 1;
const userExists = (id: string) =>
  Number(psql(`select count(*) from auth.users where id = '${id}'`)) === 1;

beforeAll(() => {
  supabase = localSupabase();
});
beforeEach(() => psql("delete from private.demo_cleanup_users"));
afterAll(() => {
  if (created.length) {
    const ids = created.map((i) => `'${i}'`).join(",");
    psql(`delete from public.organizations where created_by in (${ids})`);
    psql(`delete from auth.users where id in (${ids})`);
  }
  psql("delete from private.demo_cleanup_users");
  delete process.env.SUPABASE_SECRET_KEY;
});

function useEnv(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("the scheduled function handler", () => {
  it("purges an expired demo and its guest, leaves an active demo alone, and answers with counts only", async () => {
    const [dead, live] = await Promise.all([guest(), guest()]);
    expire(dead);
    useEnv({
      NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl,
      SUPABASE_SECRET_KEY: supabase.secretKey,
      LOG_LEVEL: "silent",
    });
    const res = await handler();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, errors: 0 });
    expect(body.orgsDeleted).toBeGreaterThanOrEqual(1);
    expect(orgExists(dead.org)).toBe(false);
    expect(userExists(dead.id)).toBe(false);
    expect(orgExists(live.org)).toBe(true);
    expect(userExists(live.id)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(supabase.secretKey);
    // a second run finds nothing more of ours
    const again = await (await handler()).json();
    expect(again.ok).toBe(true);
    expect(orgExists(live.org)).toBe(true);
  }, 60_000);

  it("refuses with a code (500) when the secret key or URL is missing, before any network call", async () => {
    useEnv({ NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl, SUPABASE_SECRET_KEY: undefined });
    const res = await handler();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, code: "MISSING_SECRET" });
    useEnv({ NEXT_PUBLIC_SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: supabase.secretKey });
    expect((await (await handler()).json()).code).toBe("MISSING_URL");
  });

  it("is registered as an hourly scheduled function", async () => {
    const mod = await import("../../../netlify/functions/cleanup-demo.mts");
    expect(mod.config).toEqual({ schedule: "@hourly" });
  });
});

describe("npm run demo:cleanup", () => {
  const run = (env: Record<string, string | undefined>, args: string[] = []) =>
    spawnSync("npx", ["tsx", "scripts/demo-cleanup.mts", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_SECRET_KEY: "",
        NEXT_PUBLIC_SUPABASE_URL: "",
        ...env,
      } as NodeJS.ProcessEnv,
      timeout: 90_000,
    });

  it("purges an expired fixture and leaves an active one on a local project, exits 0, and prints no secret", async () => {
    const [dead, live] = await Promise.all([guest(), guest()]);
    expire(dead);
    const r = run({
      NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl,
      SUPABASE_SECRET_KEY: supabase.secretKey,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(
      /demo:cleanup finished on (127\.0\.0\.1|localhost): \d+ workspaces and \d+ guests removed, 0 errors/,
    );
    expect(orgExists(dead.org)).toBe(false);
    expect(userExists(dead.id)).toBe(false);
    expect(orgExists(live.org)).toBe(true);
    expect(`${r.stdout}${r.stderr}`).not.toContain(supabase.secretKey);
  }, 120_000);

  it("refuses (exit 2) a non-local URL without the exact confirmation, a missing secret, and a missing URL, without touching the network", () => {
    const remote = {
      NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_fake_for_test",
    };
    const a = run(remote);
    expect(a.status).toBe(2);
    expect(a.stderr).toContain("CONFIRM_REQUIRED");
    expect(a.stderr).toContain("--confirm-remote abcd1234.supabase.co");
    expect(run(remote, ["--confirm-remote", "wrong.supabase.co"]).status).toBe(2);
    expect(run({ ...remote, SUPABASE_SECRET_KEY: "" }).stderr).toContain("MISSING_SECRET");
    expect(run({ ...remote, NEXT_PUBLIC_SUPABASE_URL: "" }).stderr).toContain("MISSING_URL");
    for (const r of [a]) expect(`${r.stdout}${r.stderr}`).not.toContain("sb_secret_fake_for_test");
  }, 120_000);

  it("with the exact confirmation a remote URL is allowed to start (it then fails to connect, exit 1, with no secret printed)", () => {
    const r = run(
      {
        NEXT_PUBLIC_SUPABASE_URL: "https://does-not-exist.invalid",
        SUPABASE_SECRET_KEY: "sb_secret_fake_for_test",
      },
      ["--confirm-remote", "does-not-exist.invalid"],
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).not.toContain("sb_secret_fake_for_test");
    expect(r.stderr).not.toContain("CONFIRM_REQUIRED");
  }, 120_000);
});
