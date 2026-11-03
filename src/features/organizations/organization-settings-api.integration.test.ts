import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInZone } from "@/lib/domain/tasks";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** PATCH /api/v1/organizations/:id over real HTTP (production build, local Supabase) (SIT-232, PRD 7.4, 9.8, US-09). */
const server = new RealServer();
let owner: Actor,
  admin: Actor,
  member: Actor,
  viewer: Actor,
  other: Actor,
  outsider: Actor,
  guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hdr = (org: string) => ({ "X-Organization-Id": org });
const patch = (actor: Actor | null, id: string, json: unknown, org = id) =>
  server.request(`/api/v1/organizations/${id}`, actor, {
    method: "PATCH",
    json,
    headers: hdr(org),
  });
const get = async (actor: Actor, id: string): Promise<any> =>
  (await (await server.request(`/api/v1/organizations/${id}`, actor, { headers: hdr(id) })).json())
    .data;
const body = async (res: Response): Promise<any> => res.json();
const row = (id: string) =>
  psql(
    `select name || '|' || coalesce(industry, '') || '|' || timezone from public.organizations where id = '${id}'`,
  );

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, other, outsider, guest] = await Promise.all([
    server.member("set-owner"),
    server.member("set-admin"),
    server.member("set-member"),
    server.member("set-viewer"),
    server.member("set-other"),
    server.member("set-outsider"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Settings Co A");
  orgB = await createOrg(other, "Settings Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
}, 400_000);

afterAll(() => server.stop());

describe("PATCH /organizations/:id", () => {
  it("an owner renames, sets the industry and changes the time zone; the response and the row agree", async () => {
    const before = await get(owner, orgA);
    expect(before.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const res = await patch(owner, orgA, {
      name: "  Settings Co Renamed  ",
      industry: "Plumbing",
      timezone: "America/Chicago",
      expectedUpdatedAt: before.updatedAt,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const { data } = await body(res);
    expect(data).toMatchObject({
      id: orgA,
      name: "Settings Co Renamed",
      industry: "Plumbing",
      timezone: "America/Chicago",
    });
    expect(data.updatedAt).not.toBe(before.updatedAt);
    expect(row(orgA)).toBe("Settings Co Renamed|Plumbing|America/Chicago");
    const after = await get(owner, orgA);
    expect(after).toMatchObject({
      name: "Settings Co Renamed",
      timezone: "America/Chicago",
      updatedAt: data.updatedAt,
    });
  });

  it("an admin can too; a blank industry clears it", async () => {
    const cur = await get(admin, orgA);
    const res = await patch(admin, orgA, { industry: "", expectedUpdatedAt: cur.updatedAt });
    expect(res.status).toBe(200);
    expect((await body(res)).data.industry).toBeNull();
    expect(row(orgA)).toBe("Settings Co Renamed||America/Chicago");
  });

  it("a member and a viewer get 403 at the API and nothing changes", async () => {
    const cur = await get(owner, orgA);
    for (const actor of [member, viewer]) {
      const res = await patch(actor, orgA, { name: "Hijacked", expectedUpdatedAt: cur.updatedAt });
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe("FORBIDDEN");
    }
    expect(row(orgA)).toBe("Settings Co Renamed||America/Chicago");
  });

  it("a non-member and a signed-out caller are refused; another workspace's id in the path is 404", async () => {
    const cur = await get(owner, orgA);
    expect(
      (await patch(outsider, orgA, { name: "Nope", expectedUpdatedAt: cur.updatedAt })).status,
    ).toBe(404);
    expect(
      (await patch(null, orgA, { name: "Nope", expectedUpdatedAt: cur.updatedAt })).status,
    ).toBe(401);
    // the header names A, the path names B: the owner of A has no business with B
    const mismatch = await patch(
      owner,
      orgB,
      { name: "Nope", expectedUpdatedAt: cur.updatedAt },
      orgA,
    );
    expect(mismatch.status).toBe(404);
    // the owner of B cannot reach A through B's header either
    const crossing = await patch(
      other,
      orgA,
      { name: "Nope", expectedUpdatedAt: cur.updatedAt },
      orgB,
    );
    expect(crossing.status).toBe(404);
    expect(row(orgA)).toBe("Settings Co Renamed||America/Chicago");
    expect(row(orgB)).toBe("Settings Co B||UTC");
  });

  it("a demo guest gets 403 and the demo keeps its name", async () => {
    const cur = await get(guest, demoOrg);
    const res = await patch(guest, demoOrg, { name: "My Demo", expectedUpdatedAt: cur.updatedAt });
    expect(res.status).toBe(403);
    expect(row(demoOrg)).not.toMatch(/^My Demo/);
  });

  it("kind, expiresAt, currency, slug and unknown fields are a 422 and change nothing", async () => {
    const cur = await get(owner, orgA);
    for (const extra of [
      { kind: "demo" },
      { expiresAt: "2030-01-01T00:00:00Z" },
      { expires_at: "2030-01-01T00:00:00Z" },
      { currency: "EUR" },
      { slug: "x" },
      { id: orgB },
      { whatever: 1 },
    ]) {
      const res = await patch(owner, orgA, {
        name: "Valid Name",
        expectedUpdatedAt: cur.updatedAt,
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(
      psql(
        `select kind || '|' || coalesce(expires_at::text, 'none') || '|' || currency from public.organizations where id = '${orgA}'`,
      ),
    ).toBe("real|none|USD");
    expect(row(orgA)).toBe("Settings Co Renamed||America/Chicago");
  });

  it("422 for a bad name, an unknown time zone and a missing version", async () => {
    const cur = await get(owner, orgA);
    const bad = async (json: unknown) => body(await patch(owner, orgA, json));
    expect(
      (await bad({ name: "A", expectedUpdatedAt: cur.updatedAt })).error.fieldErrors.name,
    ).toBeTruthy();
    expect(
      (await bad({ name: "<b>x</b> Co", expectedUpdatedAt: cur.updatedAt })).error.fieldErrors.name,
    ).toBeTruthy();
    expect(
      (await bad({ timezone: "Mars/Base", expectedUpdatedAt: cur.updatedAt })).error.fieldErrors
        .timezone,
    ).toBeTruthy();
    expect(
      (await bad({ name: "x".repeat(81), expectedUpdatedAt: cur.updatedAt })).error.fieldErrors
        .name,
    ).toBeTruthy();
    expect((await bad({ name: "Valid Name" })).error.fieldErrors.expectedUpdatedAt).toBeTruthy();
    expect(row(orgA)).toBe("Settings Co Renamed||America/Chicago");
  });

  it("a stale version is 409 STALE_EDIT with the current one, and nothing is overwritten", async () => {
    const stale = await get(owner, orgA);
    const first = await patch(owner, orgA, {
      name: "Settings Co First",
      expectedUpdatedAt: stale.updatedAt,
    });
    expect(first.status).toBe(200);
    const second = await patch(admin, orgA, {
      name: "Settings Co Second",
      expectedUpdatedAt: stale.updatedAt,
    });
    expect(second.status).toBe(409);
    const err = (await body(second)).error;
    expect(err.code).toBe("STALE_EDIT");
    expect(err.meta.current.updatedAt).toBe((await body(first)).data.updatedAt);
    expect(row(orgA)).toBe("Settings Co First||America/Chicago");
  });

  it("a patch that changes nothing is a 200 that writes nothing", async () => {
    const cur = await get(owner, orgA);
    const res = await patch(owner, orgA, {
      name: cur.name,
      timezone: cur.timezone,
      expectedUpdatedAt: cur.updatedAt,
    });
    expect(res.status).toBe(200);
    expect((await body(res)).data.updatedAt).toBe(cur.updatedAt);
  });
});

describe("a time zone change moves what counts as overdue", () => {
  it("the same task is not overdue in one zone and overdue in another, immediately after the change", async () => {
    // 25 hours apart: whenever it is "today" in Pago Pago, it is already "tomorrow" in Kiritimati
    const early = "Pacific/Pago_Pago";
    const late = "Pacific/Kiritimati";
    const dueInEarlyZone = todayInZone(new Date(), early);
    expect(todayInZone(new Date(), late) > dueInEarlyZone).toBe(true);

    let cur = await get(owner, orgA);
    let res = await patch(owner, orgA, { timezone: early, expectedUpdatedAt: cur.updatedAt });
    expect(res.status).toBe(200);
    const made = await server.request("/api/v1/tasks", owner, {
      json: { title: "Zone sensitive task", dueDate: dueInEarlyZone },
      headers: hdr(orgA),
    });
    expect(made.status).toBe(201);
    const overdueIds = async () =>
      (
        (
          await (
            await server.request("/api/v1/tasks?overdue=true&limit=100", owner, {
              headers: hdr(orgA),
            })
          ).json()
        ).data as any[]
      ).map((t) => t.title);
    const dashboardOverdue = async () =>
      (await (await server.request("/api/v1/dashboard", owner, { headers: hdr(orgA) })).json())
        .data;

    expect(await overdueIds()).not.toContain("Zone sensitive task"); // due today in this zone
    const countBefore = JSON.stringify(await dashboardOverdue()).match(/"overdueTasks":(\d+)/)?.[1];

    cur = await get(owner, orgA);
    res = await patch(owner, orgA, { timezone: late, expectedUpdatedAt: cur.updatedAt });
    expect(res.status).toBe(200);
    expect(await overdueIds()).toContain("Zone sensitive task"); // the same date is now in the past
    const countAfter = JSON.stringify(await dashboardOverdue()).match(/"overdueTasks":(\d+)/)?.[1];
    expect(Number(countAfter)).toBe(Number(countBefore) + 1);

    cur = await get(owner, orgA);
    res = await patch(owner, orgA, { timezone: early, expectedUpdatedAt: cur.updatedAt });
    expect(res.status).toBe(200);
    expect(await overdueIds()).not.toContain("Zone sensitive task");
  });
});
