import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-245] GET /api/v1/activity against the real production build and Supabase. */
const server = new RealServer();
let owner: Actor, member: Actor, viewer: Actor, other: Actor, outsider: Actor, guest: Actor;
let org = "";
let orgB = "";
const hdr = (o: string) => ({ "X-Organization-Id": o });
const get = (actor: Actor | null, qs = "", o = org) =>
  server.request(`/api/v1/activity${qs}`, actor, { headers: hdr(o) });
const json = async (actor: Actor | null, qs = "", o = org) => (await get(actor, qs, o)).json();
const api = (actor: Actor, method: string, path: string, body?: unknown) =>
  server.request(`/api/v1${path}`, actor, { method, json: body, headers: hdr(org) });

beforeAll(async () => {
  await server.start();
  [owner, member, viewer, other, outsider, guest] = await Promise.all([
    server.member("ac-owner"),
    server.member("ac-member"),
    server.member("ac-viewer"),
    server.member("ac-other"),
    server.member("ac-outsider"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string, timezone = "UTC") => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name, timezone } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  org = await mk(owner, "Activity Co", "Pacific/Kiritimati");
  orgB = await mk(other, "Activity Other");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${member.id}', 'member'), ('${org}', '${viewer.id}', 'viewer')`,
  );
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
  // 200 events for one record-less bulk, one per minute, ids ordered by time, plus two actors
  psql(
    `insert into public.activity_events (organization_id, entity_type, entity_id, action, actor_user_id, summary, created_at)
     select '${org}', 'task', '99999999-9999-4999-8999-999999999999', 'updated', case when g % 2 = 0 then '${owner.id}'::uuid else '${member.id}'::uuid end,
            'bulk ' || g, timestamptz '2026-01-01 00:00+00' + g * interval '1 minute' from generate_series(1, 200) g`,
  );
  // events sharing ONE instant, to prove ties are ordered stably
  psql(
    `insert into public.activity_events (organization_id, entity_type, entity_id, action, summary, created_at)
     select '${org}', 'customer', gen_random_uuid(), 'created', 'tie ' || g, timestamptz '2026-02-01 00:00+00' from generate_series(1, 30) g`,
  );
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/activity [SIT-245]", () => {
  it("401 signed out; 404 for a non-member and for an unknown workspace; 422 for bad parameters with field errors", async () => {
    expect((await get(null)).status).toBe(401);
    const denied = await get(outsider);
    expect(denied.status).toBe(404);
    expect(JSON.stringify(await denied.json())).not.toMatch(/list_activity|SELECT/i);
    expect((await get(owner, "", crypto.randomUUID())).status).toBe(404);
    for (const qs of [
      "?limit=101",
      "?page=0",
      "?entityType=nope",
      "?entityId=x",
      "?action=nope",
      "?actor=nobody",
      "?from=2026-13-01",
      "?from=2026-03-02&to=2026-03-01",
      "?sort=summary",
      "?bogus=1",
    ]) {
      const res = await get(owner, qs);
      expect(res.status, qs).toBe(422);
      expect((await res.json()).error.requestId).toBeTruthy();
    }
  });

  it("returns the standard envelope and meta; every role that can read the workspace can read it", async () => {
    for (const actor of [owner, member, viewer]) {
      const res = await get(actor, "?limit=5");
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBeTruthy();
      const body = await res.json();
      expect(body.meta).toMatchObject({ page: 1, limit: 5, total: 230, totalPages: 46 });
      expect(Object.keys(body.data[0]).sort()).toEqual([
        "action",
        "actorName",
        "actorUserId",
        "changes",
        "contentChanged",
        "createdAt",
        "entityId",
        "entityType",
        "id",
        "summary",
      ]);
    }
  });

  it("230 events paginate with a stable order: no repeats, no gaps, same order twice, ties by id", async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await json(owner, `?limit=25&page=${page}`);
      seen.push(...body.data.map((e: { id: string }) => e.id));
    }
    expect(seen).toHaveLength(230); // 10 pages of 25 = 250, so the last page is short
    expect(new Set(seen).size).toBe(seen.length);
    const again: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const body = await json(owner, `?limit=25&page=${page}`);
      again.push(...body.data.map((e: { id: string }) => e.id));
    }
    expect(again).toEqual(seen);
    const all = await Promise.all([1, 2].map((p) => json(owner, `?limit=100&page=${p}`)));
    const times = all.flatMap((b) =>
      b.data.map((e: { createdAt: string }) => Date.parse(e.createdAt)),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // the 30 tied events come first (newest instant) in descending id order
    const firstThirty = (await json(owner, "?limit=30")).data.map((e: { id: string }) => e.id);
    expect(firstThirty).toEqual([...firstThirty].sort().reverse());
    // oldest first reverses the time order
    const asc = await json(owner, "?limit=3&order=asc");
    expect(asc.data.map((e: { summary: string }) => e.summary)).toEqual([
      "bulk 1",
      "bulk 2",
      "bulk 3",
    ]);
    // a page past the end is empty with the real total
    const past = await json(owner, "?page=50&limit=25");
    expect(past.data).toEqual([]);
    expect(past.meta).toMatchObject({ page: 50, total: 230, totalPages: 10 });
  });

  it("filtering by entity returns that record's timeline, including what the API itself logged", async () => {
    const customer = (
      await (await api(owner, "POST", "/customers", { displayName: "Timeline Co" })).json()
    ).data;
    const patched = await api(owner, "PATCH", `/customers/${customer.id}`, {
      status: "active",
      expectedUpdatedAt: customer.updatedAt,
    });
    expect(patched.status).toBe(200);
    expect((await api(owner, "DELETE", `/customers/${customer.id}`)).status).toBe(204);
    const body = await json(owner, `?entityType=customer&entityId=${customer.id}`);
    expect(body.data.map((e: { action: string }) => e.action)).toEqual([
      "archived",
      "updated",
      "created",
    ]);
    expect(body.data.every((e: { entityId: string }) => e.entityId === customer.id)).toBe(true);
    expect(body.meta.total).toBe(3);
    const updated = body.data[1];
    expect(updated.changes).toEqual([{ field: "status", old: "lead", new: "active" }]);
    expect(updated.actorName).toBeTruthy();
    expect(updated.actorUserId).toBe(owner.id);
  });

  it("filters: action, actor (a member or system), entity type, and a date range in the organization's time zone", async () => {
    expect(
      (await json(owner, "?action=updated&limit=100")).data.every(
        (e: { action: string }) => e.action === "updated",
      ),
    ).toBe(true);
    const byMember = await json(owner, `?actor=${member.id}&limit=100`);
    expect(byMember.meta.total).toBe(100);
    expect(byMember.data.every((e: { actorUserId: string }) => e.actorUserId === member.id)).toBe(
      true,
    );
    const system = await json(owner, "?actor=system&limit=100");
    expect(system.data.length).toBeGreaterThanOrEqual(30);
    expect(
      system.data.every(
        (e: { actorName: string; actorUserId: null }) =>
          e.actorUserId === null && e.actorName === "System",
      ),
    ).toBe(true);
    expect((await json(owner, "?entityType=task&limit=100")).meta.total).toBe(200);
    // 2026-01-01 00:01 UTC is 14:01 on Jan 1 in Kiritimati; the 200 minutes run to 03:20 UTC on Jan 1, all one local day
    expect((await json(owner, "?from=2026-01-01&to=2026-01-01")).meta.total).toBe(200);
    expect((await json(owner, "?from=2025-12-31&to=2025-12-31")).meta.total).toBe(0);
    // the 30 tied events at 2026-02-01 00:00 UTC are 2026-02-01 14:00 local
    expect((await json(owner, "?from=2026-02-01&to=2026-02-01")).meta.total).toBe(30);
    expect((await json(owner, "?from=2026-01-31&to=2026-01-31")).meta.total).toBe(0);
  });

  it("names people through the workspace only: members by display name, a removed member as Former member", async () => {
    const named = await json(owner, `?actor=${owner.id}&limit=1`);
    expect(named.data[0].actorName).not.toBe("Former member");
    expect(named.data[0].actorName).not.toBe("System");
    psql(
      `delete from public.memberships where organization_id = '${org}' and user_id = '${member.id}'`,
    );
    const former = await json(owner, `?actor=${member.id}&limit=1`);
    expect(former.data[0].actorUserId).toBe(member.id);
    expect(former.data[0].actorName).toBe("Former member");
    psql(
      `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${member.id}', 'member')`,
    );
  });

  it("cross-tenant events never appear: B's feed holds only B's, and A's record ids return nothing inside B", async () => {
    await api(owner, "POST", "/customers", { displayName: "A only record" });
    await server.request("/api/v1/customers", other, {
      json: { displayName: "B secret record" },
      headers: hdr(orgB),
    });
    const a = JSON.stringify((await json(owner, "?limit=100")).data);
    const b = await json(other, "?limit=100", orgB);
    expect(a).not.toContain("B secret record");
    expect(JSON.stringify(b.data)).not.toContain("A only record");
    expect(b.meta.total).toBe(1);
    const aRecord = psql(
      `select entity_id from public.activity_events where organization_id = '${org}' and entity_type = 'task' limit 1`,
    );
    expect((await json(other, `?entityId=${aRecord}`, orgB)).data).toEqual([]);
    expect((await get(other, "", org)).status).toBe(404);
  });

  it("a guest reads their own seeded history", async () => {
    const body = await (await server.request("/api/v1/activity?limit=100", guest)).json();
    expect(body.meta.total).toBe(44);
    expect(body.data.every((e: { actorName: string }) => e.actorName === "System")).toBe(true);
    const stage = await (
      await server.request("/api/v1/activity?action=stage_changed", guest)
    ).json();
    expect(stage.meta.total).toBe(8);
  });
});
