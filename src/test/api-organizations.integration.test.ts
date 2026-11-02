import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** The session and organization endpoints over real HTTP (production build, local Supabase, real sessions). */
const server = new RealServer();
let alice: Actor;
let bob: Actor;
let guest: Actor;
let guest2: Actor;
let aliceOrg = "";
let bobOrg = "";
let guestOrg = "";

beforeAll(async () => {
  await server.start();
  [alice, bob, guest, guest2] = await Promise.all([
    server.member("alice"),
    server.member("bob"),
    server.guest(),
    server.guest(),
  ]);
  // bootstrap a demo for the guest through the real RPC (as the demo route will)
  const { createClient } = await import("@supabase/supabase-js");
  const g = createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
    global: {
      headers: {
        Authorization: `Bearer ${JSON.parse(Buffer.from(guest.cookie.split("=base64-")[1], "base64url").toString()).access_token}`,
      },
    },
  });
  guestOrg = ((await g.rpc("bootstrap_demo_workspace")).data as { organization_id: string })
    .organization_id;
}, 400_000);

afterAll(() => server.stop());

// Test helper over arbitrary response JSON.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = {
  data: any;
  meta: any;
  error: {
    code: string;
    message: string;
    requestId: string;
    fieldErrors: Record<string, string[]>;
  };
};
const json = async (res: Response) => (await res.json()) as Body;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("POST /api/v1/organizations", () => {
  it("201: creates a workspace for a registered user and returns it", async () => {
    const res = await server.request("/api/v1/organizations", alice, {
      json: { name: "  Acme Plumbing ", industry: "Plumbing", timezone: "America/Chicago" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const body = await json(res);
    expect(body.meta).toEqual({});
    expect(body.data).toMatchObject({
      name: "Acme Plumbing",
      kind: "real",
      role: "owner",
      timezone: "America/Chicago",
      expiresAt: null,
      secondsRemaining: null,
      expired: false,
    });
    aliceOrg = body.data.id;
    expect(
      Number(
        psql(
          `select count(*) from public.memberships where organization_id = '${aliceOrg}' and user_id = '${alice.id}' and role = 'owner'`,
        ),
      ),
    ).toBe(1);
  });
  it("201: a second user creates their own", async () => {
    const res = await server.request("/api/v1/organizations", bob, {
      json: { name: "Bob's Roofing" },
    });
    expect(res.status).toBe(201);
    bobOrg = (await json(res)).data.id;
    expect(
      (await json(await server.request(`/api/v1/organizations/${bobOrg}`, bob))).data.timezone,
    ).toBe("UTC");
  });
  it("422: field errors for a bad body", async () => {
    const res = await server.request("/api/v1/organizations", alice, {
      json: { name: "A", timezone: "Mars/Base" },
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(body.error.fieldErrors).sort()).toEqual(["name", "timezone"]);
    expect(body.error.requestId).toBeTruthy();
  });
  it("422: unknown fields such as owner_id are rejected, so an owner cannot be injected", async () => {
    const res = await server.request("/api/v1/organizations", alice, {
      json: { name: "Sneaky Co", owner_id: bob.id, kind: "demo" },
    });
    expect(res.status).toBe(422);
    expect(Number(psql(`select count(*) from public.organizations where name = 'Sneaky Co'`))).toBe(
      0,
    );
  });
  it("403: a guest cannot create a real workspace", async () => {
    const res = await server.request("/api/v1/organizations", guest, {
      json: { name: "Guest Co" },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("ACCOUNT_REQUIRED");
    expect(Number(psql(`select count(*) from public.organizations where name = 'Guest Co'`))).toBe(
      0,
    );
  });
  it("401: signed out", async () => {
    const res = await server.request("/api/v1/organizations", null, {
      json: { name: "Nobody Co" },
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error.code).toBe("UNAUTHENTICATED");
  });
  it("403: a cross-origin POST is refused before anything else", async () => {
    const res = await server.request("/api/v1/organizations", alice, {
      json: { name: "Evil Co" },
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("ORIGIN_FORBIDDEN");
    expect(Number(psql(`select count(*) from public.organizations where name = 'Evil Co'`))).toBe(
      0,
    );
  });
  it("429: the per-user limit is reported in the envelope", async () => {
    const carol = await server.member("carol");
    for (let i = 1; i <= 5; i++)
      expect(
        (await server.request("/api/v1/organizations", carol, { json: { name: `Carol ${i}` } }))
          .status,
      ).toBe(201);
    const res = await server.request("/api/v1/organizations", carol, { json: { name: "Carol 6" } });
    expect(res.status).toBe(429);
    expect((await json(res)).error.code).toBe("ORG_LIMIT");
  });
});

describe("GET /api/v1/organizations and /api/v1/organizations/:id", () => {
  it("200: lists only the caller's workspaces", async () => {
    const res = await server.request("/api/v1/organizations", alice);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((o: { id: string }) => o.id)).toEqual([aliceOrg]);
    expect(body.meta).toEqual({ total: 1 });
    const bobs = await json(await server.request("/api/v1/organizations", bob));
    expect(bobs.data.map((o: { id: string }) => o.id)).toEqual([bobOrg]);
  });
  it("200: reads one workspace with its role", async () => {
    const res = await server.request(`/api/v1/organizations/${aliceOrg}`, alice);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      id: aliceOrg,
      name: "Acme Plumbing",
      industry: "Plumbing",
      currency: "USD",
      role: "owner",
      kind: "real",
    });
  });
  it("404: another tenant's id is indistinguishable from an unknown id", async () => {
    const foreign = await server.request(`/api/v1/organizations/${bobOrg}`, alice);
    const unknown = await server.request(
      "/api/v1/organizations/99999999-9999-4999-8999-999999999999",
      alice,
    );
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await json(foreign)).error.message).toBe((await json(unknown)).error.message);
  });
  it("404: a guest cannot read a real tenant, and a real user cannot read a guest's demo", async () => {
    expect((await server.request(`/api/v1/organizations/${aliceOrg}`, guest)).status).toBe(404);
    expect((await server.request(`/api/v1/organizations/${guestOrg}`, alice)).status).toBe(404);
    expect((await server.request(`/api/v1/organizations/${guestOrg}`, guest2)).status).toBe(404);
  });
  it("400: a malformed id; 401: signed out", async () => {
    expect((await server.request("/api/v1/organizations/not-a-uuid", alice)).status).toBe(400);
    expect((await server.request(`/api/v1/organizations/${aliceOrg}`, null)).status).toBe(401);
    expect((await server.request("/api/v1/organizations", null)).status).toBe(401);
  });
  it("never leaks another tenant in any list", async () => {
    for (const actor of [alice, bob, guest, guest2]) {
      const body = await json(await server.request("/api/v1/organizations", actor));
      const ids: string[] = body.data.map((o: { id: string }) => o.id);
      for (const foreign of [aliceOrg, bobOrg, guestOrg].filter((id) => !ids.includes(id))) {
        expect(ids).not.toContain(foreign);
      }
    }
    expect((await json(await server.request("/api/v1/organizations", alice))).data.length).toBe(1);
  });
});

describe("GET /api/v1/session", () => {
  it("200: a member sees their user, workspaces and no demo", async () => {
    const res = await server.request("/api/v1/session", alice);
    expect(res.status).toBe(200);
    const { data } = await json(res);
    expect(data.user).toMatchObject({ id: alice.id, email: alice.email, isAnonymous: false });
    expect(data.user.displayName).toBeTruthy();
    expect(data.organizations.map((o: { id: string }) => o.id)).toEqual([aliceOrg]);
    expect(data.demo).toBeNull();
  });
  it("200: a guest sees isAnonymous true, no email, and the demo expiry", async () => {
    const { data } = await json(await server.request("/api/v1/session", guest));
    expect(data.user).toMatchObject({
      id: guest.id,
      email: null,
      isAnonymous: true,
      displayName: "Demo Owner",
    });
    expect(data.organizations).toHaveLength(1);
    expect(data.organizations[0]).toMatchObject({ id: guestOrg, kind: "demo", role: "owner" });
    expect(data.demo.organizationId).toBe(guestOrg);
    expect(data.demo.expired).toBe(false);
    expect(data.demo.secondsRemaining).toBeGreaterThan(24 * 3600 - 120);
    expect(data.demo.secondsRemaining).toBeLessThanOrEqual(24 * 3600);
    expect(new Date(data.demo.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
  it("200: a guest who never bootstrapped has no workspaces and no demo", async () => {
    const { data } = await json(await server.request("/api/v1/session", guest2));
    expect(data.organizations).toEqual([]);
    expect(data.demo).toBeNull();
  });
  it("an expired demo is reported as expired with zero seconds", async () => {
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${guestOrg}'`,
    );
    try {
      const { data } = await json(await server.request("/api/v1/session", guest));
      expect(data.demo).toMatchObject({ expired: true, secondsRemaining: 0 });
      const org = await json(await server.request(`/api/v1/organizations/${guestOrg}`, guest));
      expect(org.data).toMatchObject({ expired: true, secondsRemaining: 0, kind: "demo" });
    } finally {
      psql(
        `update public.organizations set expires_at = now() + interval '24 hours' where id = '${guestOrg}'`,
      );
    }
  });
  it("401: signed out; and a tampered cookie is treated as signed out", async () => {
    expect((await server.request("/api/v1/session", null)).status).toBe(401);
    const [name, value] = alice.cookie.split("=base64-");
    const session = JSON.parse(Buffer.from(value, "base64url").toString());
    session.access_token = `${session.access_token.slice(0, -4)}AAAA`;
    session.refresh_token = "forged";
    const forged = `${name}=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
    expect((await server.request("/api/v1/session", { ...alice, cookie: forged })).status).toBe(
      401,
    );
  });
});
