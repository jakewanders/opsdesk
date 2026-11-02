import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer } from "@/test/real-server";

/** POST /api/v1/demo/bootstrap and /demo against the production build and the local Supabase stack. */
const server = new RealServer();
const URL_PATH = "/api/v1/demo/bootstrap";
const run = Date.now();

beforeAll(async () => {
  await server.start();
}, 180_000);
afterAll(() => server.stop());

const orgCount = (userId: string) =>
  Number(psql(`select count(*) from public.memberships where user_id = '${userId}'`));

describe("POST /api/v1/demo/bootstrap", () => {
  it("gives a guest a seeded demo workspace with its id and expiry, and makes it the active workspace", async () => {
    const guest = await server.guest();
    const res = await server.request(URL_PATH, guest, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.data.organizationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(body.data.created).toBe(true);
    expect(res.headers.get("set-cookie")).toContain(`od_active_org=${body.data.organizationId}`);
    expect(res.headers.get("set-cookie")?.toLowerCase()).toContain("httponly");
    expect(orgCount(guest.id)).toBe(1);
    // seeded: the workspace has the registered seed version
    expect(
      Number(
        psql(
          `select count(*) from public.demo_workspaces where organization_id = '${body.data.organizationId}'`,
        ),
      ),
    ).toBe(1);
  });

  it("is the same workspace on every call, with or without a key (reopening /demo restores the org)", async () => {
    const guest = await server.guest();
    const a = await (await server.request(URL_PATH, guest, { method: "POST" })).json();
    const b = await (await server.request(URL_PATH, guest, { method: "POST" })).json();
    expect(b.data.organizationId).toBe(a.data.organizationId);
    expect(b.data.created).toBe(false);
    expect(orgCount(guest.id)).toBe(1);
  });

  it("replays the stored answer for the same Idempotency-Key", async () => {
    const guest = await server.guest();
    const headers = { "Idempotency-Key": `boot-${run}-aaaa1111` };
    const first = await (await server.request(URL_PATH, guest, { method: "POST", headers })).json();
    const second = await server.request(URL_PATH, guest, { method: "POST", headers });
    expect(second.status).toBe(200);
    expect((await second.json()).data).toEqual(first.data);
    expect(
      Number(psql(`select count(*) from private.idempotency_keys where user_id = '${guest.id}'`)),
    ).toBe(1);
  });

  it("five simultaneous calls from one guest create exactly one workspace", async () => {
    const guest = await server.guest();
    const headers = { "Idempotency-Key": `race-${run}-bbbb2222` };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => server.request(URL_PATH, guest, { method: "POST", headers })),
    );
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(orgCount(guest.id)).toBe(1);
  });

  it("refuses a malformed Idempotency-Key with 422 and creates nothing", async () => {
    const guest = await server.guest();
    const res = await server.request(URL_PATH, guest, {
      method: "POST",
      headers: { "Idempotency-Key": "bad key!" },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(orgCount(guest.id)).toBe(0);
  });

  it("rejects a registered (non-anonymous) session with 403 and gives them no workspace", async () => {
    const member = await server.member("boot");
    const res = await server.request(URL_PATH, member, { method: "POST" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("GUEST_ONLY");
    expect(orgCount(member.id)).toBe(0);
  });

  it("rejects a signed-out caller with 401 and a foreign Origin with 403", async () => {
    expect((await server.request(URL_PATH, null, { method: "POST" })).status).toBe(401);
    const guest = await server.guest();
    const evil = await server.request(URL_PATH, guest, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(orgCount(guest.id)).toBe(0);
  });

  it("answers GET with 405 (it only accepts POST)", async () => {
    const guest = await server.guest();
    expect((await server.request(URL_PATH, guest, { method: "GET" })).status).toBe(405);
  });
});

describe("/demo page", () => {
  it("sends a guest with a live demo straight to /app, and shows the entry flow to a visitor with no session", async () => {
    const guest = await server.guest();
    await server.request(URL_PATH, guest, { method: "POST" });
    const back = await server.request("/demo", guest);
    // The page redirects while streaming, so the response is 200 with the redirect in the body, not a 307.
    const html = await back.text();
    expect(html).toMatch(/NEXT_REDIRECT|http-equiv="refresh"[^>]*\/app/);
    expect(html).not.toContain("Opening your demo");
    const visitor = await server.request("/demo", null);
    expect(visitor.status).toBe(200);
    const entry = await visitor.text();
    expect(entry).toContain("Opening your demo");
    expect(entry).toContain("Running a quick security check");
  });

  it("tells a signed-in member the demo is for guests", async () => {
    const member = await server.member("demo");
    const res = await server.request("/demo", member);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You are signed in");
  });

  it("a guest with a session but no workspace (sign-in worked, setup did not) gets the entry flow again", async () => {
    const guest = await server.guest();
    const res = await server.request("/demo", guest);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Opening your demo");
  });
});
