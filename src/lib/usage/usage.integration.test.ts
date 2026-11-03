import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupExpiredDemos } from "@/lib/cleanup/cleanup";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [P-03, SIT-146] The first-party daily usage counts end to end, over real HTTP (production build) and the local stack: guests
 * start demos and act through the public API, their demos expire, the REAL cleanup runs, and the day's counters hold exactly
 * what the visitors did (never the seed's sample data), once, even when the cleanup runs again.
 *
 *   A  creates a customer          B  does everything: customer, deal moved a stage, task completed, quote
 *   C  creates a customer, then resets the demo (the reset deletes the customer; it must still count)
 *   D  only starts the demo (unused)
 */
const server = new RealServer();
const METRICS = [
  "demos_started",
  "demos_with_customer_created",
  "demos_with_stage_move",
  "demos_with_task_completed",
  "demos_with_quote_created",
  "demos_reset",
  "demos_expired_unused",
] as const;
type Counts = Record<(typeof METRICS)[number], number>;
let guests: Actor[] = [];
const orgs: string[] = [];
let day = "";
const admin = () =>
  createClient(server.supabase.apiUrl, server.supabase.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const counts = (d: string): Counts => {
  const out = Object.fromEntries(METRICS.map((m) => [m, 0])) as Counts;
  const rows = psql(
    `select metric || '=' || total from private.usage_daily where day = date '${d}'`,
  );
  for (const row of rows.split("\n").filter(Boolean)) {
    const [metric, total] = row.split("=");
    if (metric in out) out[metric as keyof Counts] = Number(total);
  }
  return out;
};
const api = (a: Actor, path: string, json?: unknown, method = "POST") =>
  server.request(`/api/v1${path}`, a, { method, json });
const ok = async (res: Response, status = 201) => {
  expect(res.status).toBe(status);
  return (await res.json()).data as { id: string; updatedAt: string };
};
const quiet = () => undefined;

beforeAll(async () => {
  await server.start();
  psql("delete from private.demo_cleanup_users");
  // Roll up and remove every demo already expired from other runs, so this file's numbers are its own.
  await cleanupExpiredDemos(admin() as never, { log: quiet });

  guests = await Promise.all([server.guest(), server.guest(), server.guest(), server.guest()]);
  for (const g of guests) {
    const res = await api(g, "/demo/bootstrap");
    expect(res.status).toBe(200);
    orgs.push((await res.json()).data.organizationId);
  }
  day = psql(
    `select ((created_at at time zone 'utc')::date)::text from public.organizations where id = '${orgs[0]}'`,
  );
}, 400_000);
afterAll(() => server.stop());

describe("[P-03] daily usage counts", () => {
  it("count what visitors did, not the seed, once, for demos that expire (and for a reset), and not again on a second cleanup", async () => {
    const [A, B, C] = guests;
    // the seed alone has produced no count: a fresh demo has none of the actions
    for (const org of orgs) {
      expect(
        psql(`select f::text from private.demo_usage_flags('${org}') f`),
        "a freshly seeded demo shows no visitor action",
      ).toBe("(f,f,f,f,f,f)");
    }
    const before = counts(day);

    await ok(await api(A, "/customers", { displayName: "Usage A Co" }));

    const cust = await ok(await api(B, "/customers", { displayName: "Usage B Co" }));
    const deal = await ok(
      await api(B, "/opportunities", { customerId: cust.id, title: "Usage deal" }),
    );
    await ok(
      await api(B, `/opportunities/${deal.id}/stage`, {
        stage: "qualified",
        expectedUpdatedAt: deal.updatedAt,
      }),
      200,
    );
    const task = await ok(await api(B, "/tasks", { title: "Usage task" }));
    await ok(
      await api(B, `/tasks/${task.id}/complete`, {
        completed: true,
        expectedUpdatedAt: task.updatedAt,
      }),
      200,
    );
    await ok(
      await api(B, "/quotes", {
        customerId: cust.id,
        title: "Usage quote",
        items: [{ description: "Line", quantity: 1, unitPriceCents: 100 }],
      }),
    );

    await ok(await api(C, "/customers", { displayName: "Usage C Co" }));
    expect((await api(C, "/demo/reset")).status).toBe(200);
    expect(
      Number(
        psql(
          `select count(*) from public.customers where organization_id = '${orgs[2]}' and display_name = 'Usage C Co'`,
        ),
      ),
      "the reset removed C's customer",
    ).toBe(0);

    // Nothing is written to the counters while the demos are alive
    expect(counts(day)).toEqual(before);

    // The live report already includes them
    const live = await admin().rpc("usage_report", { days: 2 });
    expect(live.error).toBeNull();
    const liveRows = live.data as Array<{ day: string; metric: string; total: number }>;
    expect(
      liveRows.find((r) => r.day === day && r.metric === "demos_in_progress")?.total,
    ).toBeGreaterThanOrEqual(4);

    // All four expire; the real cleanup runs
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id in (${orgs.map((o) => `'${o}'`).join(",")})`,
    );
    const first = await cleanupExpiredDemos(admin() as never, { log: quiet });
    expect(first.errors).toBe(0);
    expect(first.orgsDeleted).toBeGreaterThanOrEqual(4);

    const after = counts(day);
    expect(
      Object.fromEntries(METRICS.map((m) => [m, after[m] - before[m]])),
      "exactly what the four visitors did",
    ).toEqual({
      demos_started: 4,
      demos_with_customer_created: 3, // A, B, and C (counted before its reset deleted it)
      demos_with_stage_move: 1,
      demos_with_task_completed: 1,
      demos_with_quote_created: 1,
      demos_reset: 1,
      demos_expired_unused: 1, // D
    });

    // A second run, and a third, change nothing
    await cleanupExpiredDemos(admin() as never, { log: quiet });
    await cleanupExpiredDemos(admin() as never, { log: quiet });
    expect(counts(day)).toEqual(after);

    // The counters hold no identifier: nothing in the table is an id, and the scratch rows went with the demos
    expect(
      psql(
        `select count(*) from private.demo_usage where organization_id in (${orgs.map((o) => `'${o}'`).join(",")})`,
      ),
    ).toBe("0");
    const dump = psql("select * from private.usage_daily");
    for (const id of [...orgs, ...guests.map((g) => g.id)]) expect(dump).not.toContain(id);
    expect(dump).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(dump).not.toMatch(/@/);
  }, 300_000);

  it("`npm run usage:report` prints counts and rates only, locally, and refuses a remote URL without confirmation", () => {
    const run = (env: Record<string, string>, args: string[] = []) =>
      spawnSync("npx", ["tsx", "scripts/usage-report.mts", ...args], {
        encoding: "utf8",
        env: { ...process.env, ...env } as NodeJS.ProcessEnv,
        timeout: 90_000,
      });
    const local = run(
      {
        NEXT_PUBLIC_SUPABASE_URL: server.supabase.apiUrl,
        SUPABASE_SECRET_KEY: server.supabase.secretKey,
      },
      ["--days", "7"],
    );
    expect(local.status).toBe(0);
    expect(local.stdout).toContain("day (UTC)");
    expect(local.stdout).toContain("% started");
    expect(local.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(local.stdout).not.toContain(server.supabase.secretKey);
    const remote = run({
      NEXT_PUBLIC_SUPABASE_URL: "https://example-project.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_not_real",
    });
    expect(remote.status).toBe(2);
    expect(remote.stderr).toContain("--confirm-remote example-project.supabase.co");
    const bad = run(
      {
        NEXT_PUBLIC_SUPABASE_URL: server.supabase.apiUrl,
        SUPABASE_SECRET_KEY: server.supabase.secretKey,
      },
      ["--days", "0"],
    );
    expect(bad.status).toBe(2);
  }, 120_000);
});
