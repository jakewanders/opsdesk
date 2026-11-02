import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, isOverdue, todayInZone } from "@/lib/domain/tasks";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** /api/v1/tasks against the production build and the local stack, across roles, tenants and time zones (PRD 11.3). */
const server = new RealServer();
const PATH = "/api/v1/tasks";
let owner: Actor,
  admin: Actor,
  member: Actor,
  viewer: Actor,
  outsider: Actor,
  other: Actor,
  guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";
let acme = "";
let deal = "";
let foreignCustomer = "";
let foreignDeal = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const call = (actor: Actor | null, method: string, path = "", body?: unknown, org = orgA) =>
  server.request(`${PATH}${path}`, actor, { method, json: body, headers: hdr(org) });
const get = (actor: Actor | null, qs = "", org = orgA) => call(actor, "GET", qs, undefined, org);
const post = (actor: Actor | null, body: unknown, org = orgA) => call(actor, "POST", "", body, org);
const titles = async (res: Response) =>
  ((await res.json()).data as Array<{ title: string }>).map((t) => t.title);
const count = (org: string) =>
  Number(psql(`select count(*) from public.tasks where organization_id = '${org}'`));
const events = (id: string) =>
  psql(
    `select coalesce(string_agg(action, ',' order by created_at, id), '') from public.activity_events where entity_id = '${id}' and action <> 'created'`,
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
async function customerIn(actor: Actor, org: string, displayName: string) {
  const res = await server.request("/api/v1/customers", actor, {
    json: { displayName },
    headers: hdr(org),
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
async function dealIn(actor: Actor, org: string, customerId: string, title: string) {
  const res = await server.request("/api/v1/opportunities", actor, {
    json: { customerId, title },
    headers: hdr(org),
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, other, guest] = await Promise.all([
    server.member("tk-owner"),
    server.member("tk-admin"),
    server.member("tk-member"),
    server.member("tk-viewer"),
    server.member("tk-outsider"),
    server.member("tk-other"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Tasks Co A");
  orgB = await createOrg(other, "Tasks Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demoOrg = (await boot.json()).data.organizationId;
  acme = await customerIn(owner, orgA, "Acme Plumbing");
  deal = await dealIn(owner, orgA, acme, "Acme Retrofit");
  foreignCustomer = await customerIn(other, orgB, "Foreign Customer");
  foreignDeal = await dealIn(other, orgB, foreignCustomer, "Foreign Deal");
}, 400_000);
afterAll(() => server.stop());

describe("POST /tasks", () => {
  it("creates with defaults and returns the due state", async () => {
    const res = await post(member, { title: "  Call the client " });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({
      title: "Call the client",
      status: "todo",
      priority: "medium",
      dueDate: null,
      dueState: "none",
      completedAt: null,
      customerId: null,
      archivedAt: null,
    });
  });
  it("links a customer and a deal of the workspace and returns their names", async () => {
    const res = await post(owner, {
      title: "Linked task",
      customerId: acme,
      opportunityId: deal,
      dueDate: "2027-03-01",
      assignedTo: member.id,
      priority: "urgent",
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toMatchObject({
      customerName: "Acme Plumbing",
      opportunityTitle: "Acme Retrofit",
      assignedTo: member.id,
      priority: "urgent",
    });
  });
  it("a task created as done is stamped completed by the database; a spoofed completedAt is refused", async () => {
    const done = (await (await post(owner, { title: "Born done", status: "done" })).json()).data;
    expect(done.completedAt).not.toBeNull();
    expect(
      (await post(owner, { title: "Spoofed", completedAt: "2001-01-01T00:00:00Z" })).status,
    ).toBe(422);
  });
  it("owner, admin and member can create; a viewer is 403, signed out 401, an outsider 404, and nothing is written", async () => {
    for (const a of [owner, admin, member])
      expect((await post(a, { title: `By ${a.id.slice(0, 4)}` })).status).toBe(201);
    const before = count(orgA);
    const res = await post(viewer, { title: "Viewer task" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect((await post(null, { title: "Nobody" })).status).toBe(401);
    expect((await post(outsider, { title: "Outsider" })).status).toBe(404);
    expect(count(orgA)).toBe(before);
  });
  it("another tenant's customer or deal is 404 and nothing is written; a non-member assignee is 422", async () => {
    const before = count(orgA);
    const customer = await post(owner, { title: "Cross customer", customerId: foreignCustomer });
    const opportunity = await post(owner, { title: "Cross deal", opportunityId: foreignDeal });
    const unknown = await post(owner, {
      title: "Unknown customer",
      customerId: crypto.randomUUID(),
    });
    expect([customer.status, opportunity.status, unknown.status]).toEqual([404, 404, 404]);
    expect((await customer.json()).error.code).toBe("CUSTOMER_NOT_FOUND");
    expect((await opportunity.json()).error.code).toBe("OPPORTUNITY_NOT_FOUND");
    for (const who of [other, outsider])
      expect((await post(owner, { title: "Bad assignee", assignedTo: who.id })).status).toBe(422);
    expect(count(orgA)).toBe(before);
    expect(count(orgB)).toBe(1 - 1);
  });
  it("validation: title, description, date, enums and forged fields are 422 with field errors", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["title", { title: "x" }],
      ["title", { title: "t".repeat(161) }],
      ["description", { title: "Ok task", description: "d".repeat(5001) }],
      ["dueDate", { title: "Ok task", dueDate: "2026-02-30" }],
      ["status", { title: "Ok task", status: "open" }],
      ["priority", { title: "Ok task", priority: "critical" }],
    ];
    for (const [field, body] of bad) {
      const res = await post(owner, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(JSON.stringify((await res.json()).error)).toContain(field);
    }
    for (const forged of [
      { organizationId: orgB },
      { createdBy: member.id },
      { id: crypto.randomUUID() },
    ])
      expect((await post(owner, { title: "Forged task", ...forged })).status).toBe(422);
  });
  it("a blocked task needs no reason", async () => {
    expect((await post(owner, { title: "Stuck task", status: "blocked" })).status).toBe(201);
  });
  it("creating logs a created event by the actor", async () => {
    const id = (await (await post(admin, { title: "Logged task" })).json()).data.id;
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${id}' and action = 'created' and entity_type = 'task' and actor_user_id = '${admin.id}'`,
      ),
    ).toBe("1");
  });
});

describe("GET /tasks (list, filters, search, sort, time zones)", () => {
  let org = "";
  let customer = "";
  beforeAll(async () => {
    org = await createOrg(owner, "Tasks Fixture Co");
    addMember(org, viewer, "viewer");
    addMember(org, member, "member");
    customer = await customerIn(owner, org, "Fixture Customer");
    const today = todayInZone(new Date(), "UTC");
    const rows = [
      {
        title: "Alpha overdue",
        priority: "low",
        status: "todo",
        dueDate: addDays(today, -5),
        assignedTo: member.id,
      },
      {
        title: "Beta urgent 100% sure",
        priority: "urgent",
        status: "in_progress",
        dueDate: addDays(today, 3),
        customerId: customer,
      },
      { title: "Gamma_high", priority: "high", status: "blocked", dueDate: addDays(today, 10) },
      { title: "Delta medium nodate", priority: "medium", status: "todo", assignedTo: owner.id },
      { title: "Epsilon done", priority: "high", status: "done", dueDate: addDays(today, -9) },
    ];
    for (const r of rows) expect((await post(owner, r, org)).status).toBe(201);
    psql(
      `insert into public.tasks (organization_id, title, archived_at) values ('${org}', 'Zeta archived', now())`,
    );
  }, 120_000);

  it("pages with meta, hides archived by default, and a viewer can read", async () => {
    const res = await get(viewer, "?limit=2&sort=title&order=asc", org);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: { title: string }) => t.title)).toEqual([
      "Alpha overdue",
      "Beta urgent 100% sure",
    ]);
    expect(body.meta).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(await titles(await get(owner, "?archived=true", org))).toEqual(["Zeta archived"]);
    expect((await (await get(owner, "?archived=all", org)).json()).meta.total).toBe(6);
    const past = await (await get(owner, "?page=9", org)).json();
    expect(past.data).toEqual([]);
    expect(past.meta.total).toBe(5);
  });
  it("sorts by due date (no date last, in both directions) and by priority rank, never alphabetically", async () => {
    expect(await titles(await get(owner, "?sort=due_date&order=asc", org))).toEqual([
      "Epsilon done",
      "Alpha overdue",
      "Beta urgent 100% sure",
      "Gamma_high",
      "Delta medium nodate",
    ]);
    expect(await titles(await get(owner, "?sort=due_date&order=desc", org))).toEqual([
      "Gamma_high",
      "Beta urgent 100% sure",
      "Alpha overdue",
      "Epsilon done",
      "Delta medium nodate",
    ]);
    const byPriority = await titles(await get(owner, "?sort=priority&order=desc", org));
    expect(byPriority[0]).toBe("Beta urgent 100% sure");
    expect(byPriority.slice(1, 3).sort()).toEqual(["Epsilon done", "Gamma_high"]);
    expect(byPriority.slice(3)).toEqual(["Delta medium nodate", "Alpha overdue"]);
    expect((await titles(await get(owner, "?sort=priority&order=asc", org)))[0]).toBe(
      "Alpha overdue",
    );
  });
  it("filters: status, priority, customer, assigned to me, assignee", async () => {
    expect(await titles(await get(owner, "?status=blocked", org))).toEqual(["Gamma_high"]);
    expect(await titles(await get(owner, "?priority=high&sort=title&order=asc", org))).toEqual([
      "Epsilon done",
      "Gamma_high",
    ]);
    expect(await titles(await get(owner, `?customerId=${customer}`, org))).toEqual([
      "Beta urgent 100% sure",
    ]);
    expect(await titles(await get(member, "?assignedToMe=true", org))).toEqual(["Alpha overdue"]);
    expect(await titles(await get(owner, "?assignedToMe=true", org))).toEqual([
      "Delta medium nodate",
    ]);
    expect(await titles(await get(owner, `?assignedTo=${member.id}`, org))).toEqual([
      "Alpha overdue",
    ]);
  });
  it("overdue: not done and before today; the done task and the undated task are not overdue", async () => {
    expect(await titles(await get(owner, "?overdue=true", org))).toEqual(["Alpha overdue"]);
    expect((await titles(await get(owner, "?overdue=false", org))).length).toBe(5);
    const row = (await (await get(owner, "?overdue=true", org)).json()).data[0];
    expect(row.dueState).toBe("overdue");
  });
  it("searches titles literally (%, _, injection strings)", async () => {
    expect(await titles(await get(owner, "?q=ALPHA", org))).toEqual(["Alpha overdue"]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("100%")}`, org))).toEqual([
      "Beta urgent 100% sure",
    ]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("%")}`, org))).toEqual([
      "Beta urgent 100% sure",
    ]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("_")}`, org))).toEqual([
      "Gamma_high",
    ]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("' or 1=1 --")}`, org))).toEqual(
      [],
    );
  });
  it("refuses unknown sorts and filters, never returns another tenant's tasks", async () => {
    for (const qs of [
      "?sort=organization_id",
      "?sort=priority_rank",
      "?overdue=yes",
      "?status=open",
      "?limit=101",
      "?unknown=1",
    ])
      expect((await get(owner, qs, org)).status, qs).toBe(422);
    expect(await titles(await get(other, "", orgB))).toEqual([]);
    expect((await get(outsider, "", org)).status).toBe(404);
    expect((await get(null, "", org)).status).toBe(401);
    expect((await titles(await get(owner, "?limit=100"))).some((t) => t.includes("Alpha"))).toBe(
      false,
    );
  });

  describe("overdue follows the ORGANIZATION's calendar day, not UTC", () => {
    // Pacific/Kiritimati is UTC+14 and Pacific/Pago_Pago is UTC-11: at any moment at least one of them is on a different
    // calendar day than UTC, and the two are a day or more apart.
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      it(zone, async () => {
        const tzOrg = await createOrg(owner, `Zone ${zone}`);
        psql(`update public.organizations set timezone = '${zone}' where id = '${tzOrg}'`);
        const today = todayInZone(new Date(), zone);
        const days = { yesterday: addDays(today, -1), today, tomorrow: addDays(today, 1) };
        for (const [name, dueDate] of Object.entries(days))
          expect((await post(owner, { title: `Due ${name}`, dueDate }, tzOrg)).status).toBe(201);
        expect(
          (
            await post(
              owner,
              { title: "Done yesterday", dueDate: days.yesterday, status: "done" },
              tzOrg,
            )
          ).status,
        ).toBe(201);

        // the excluded/included set is exactly what the shared TS helper says, for the same instant
        const now = new Date();
        const tasks = (await (await get(owner, "?limit=100", tzOrg)).json()).data as Array<{
          title: string;
          dueDate: string;
          status: string;
          dueState: string;
        }>;
        const expected = tasks
          .filter((t) => isOverdue({ dueDate: t.dueDate, status: t.status }, now, zone))
          .map((t) => t.title)
          .sort();
        const overdue = (await titles(await get(owner, "?overdue=true", tzOrg))).sort();
        expect(overdue).toEqual(["Due yesterday"]);
        expect(overdue).toEqual(expected);
        expect(overdue).not.toContain("Due today");
        const byState = Object.fromEntries(tasks.map((t) => [t.title, t.dueState]));
        const flags = Object.fromEntries(
          tasks.map((t) => [t.title, (t as unknown as { dueToday: boolean }).dueToday]),
        );
        expect(flags).toMatchObject({
          "Due yesterday": false,
          "Due today": true,
          "Due tomorrow": false,
          "Done yesterday": false,
        });
        expect(byState).toMatchObject({
          "Due yesterday": "overdue",
          "Due today": "due_soon",
          "Due tomorrow": "due_soon",
          "Done yesterday": "done",
        });
      });
    }
    it("the two zones really sit on different days (the boundary is exercised)", () => {
      expect(todayInZone(new Date(), "Pacific/Kiritimati")).not.toBe(
        todayInZone(new Date(), "Pacific/Pago_Pago"),
      );
    });
  });
});

describe("GET/PATCH/DELETE /tasks/:id and POST /tasks/:id/complete", () => {
  let id = "";
  let updatedAt = "";
  const fresh = async (title: string, extra: Record<string, unknown> = {}) =>
    (await (await post(owner, { title, ...extra })).json()).data as {
      id: string;
      updatedAt: string;
    };
  beforeAll(async () => {
    const t = await fresh("Detail subject", { customerId: acme, opportunityId: deal });
    id = t.id;
    updatedAt = t.updatedAt;
  });

  it("GET returns the task with link names; a viewer can read; missing and other-tenant ids are the same 404; a bad id is 400", async () => {
    const res = await call(viewer, "GET", `/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      id,
      customerName: "Acme Plumbing",
      opportunityTitle: "Acme Retrofit",
    });
    const missing = await call(owner, "GET", `/${crypto.randomUUID()}`);
    const foreign = await call(other, "GET", `/${id}`, undefined, orgB);
    expect([missing.status, foreign.status]).toEqual([404, 404]);
    expect((await missing.json()).error.code).toBe((await foreign.json()).error.code);
    expect((await call(owner, "GET", "/not-a-uuid")).status).toBe(400);
  });
  it("PATCH updates fields; the old version is then stale (409 with the current one); no-op patches write nothing", async () => {
    const res = await call(member, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      title: "Detail subject v2",
      priority: "high",
      dueDate: "2027-02-01",
      status: "blocked",
      description: "Waiting on the supplier",
      assignedTo: admin.id,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()).data;
    expect(next).toMatchObject({
      title: "Detail subject v2",
      priority: "high",
      dueDate: "2027-02-01",
      status: "blocked",
      assignedTo: admin.id,
    });
    const stale = await call(admin, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      title: "Lost update",
    });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error.code).toBe("STALE_EDIT");
    expect(body.error.meta.current.updatedAt).toBe(next.updatedAt);
    updatedAt = next.updatedAt;
    const eventsBefore = events(id);
    const same = await call(member, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      title: "Detail subject v2",
    });
    expect(same.status).toBe(200);
    expect((await same.json()).data.updatedAt).toBe(updatedAt);
    expect(events(id)).toBe(eventsBefore);
  });
  it("two simultaneous edits: exactly one wins", async () => {
    const [a, b] = await Promise.all([
      call(owner, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, title: "Race A" }),
      call(admin, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, title: "Race B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    updatedAt = (await (await call(owner, "GET", `/${id}`)).json()).data.updatedAt;
  });
  it("clearing fields works; another tenant's customer or deal is 404; a non-member assignee is 422; forged fields are 422", async () => {
    const cleared = await call(owner, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      dueDate: null,
      assignedTo: null,
      customerId: null,
      opportunityId: null,
      description: "",
    });
    expect(cleared.status).toBe(200);
    const data = (await cleared.json()).data;
    expect(data).toMatchObject({
      dueDate: null,
      assignedTo: null,
      customerId: null,
      opportunityId: null,
      description: null,
      dueState: "none",
    });
    expect(
      (
        await call(owner, "PATCH", `/${id}`, {
          expectedUpdatedAt: data.updatedAt,
          customerId: foreignCustomer,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(owner, "PATCH", `/${id}`, {
          expectedUpdatedAt: data.updatedAt,
          opportunityId: foreignDeal,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(owner, "PATCH", `/${id}`, {
          expectedUpdatedAt: data.updatedAt,
          assignedTo: other.id,
        })
      ).status,
    ).toBe(422);
    for (const forged of [
      { organizationId: orgB },
      { createdBy: member.id },
      { id: crypto.randomUUID() },
      { completedAt: "2026-01-01T00:00:00Z" },
    ])
      expect(
        (await call(owner, "PATCH", `/${id}`, { expectedUpdatedAt: data.updatedAt, ...forged }))
          .status,
      ).toBe(422);
    expect(
      psql(
        `select customer_id is null and opportunity_id is null from public.tasks where id = '${id}'`,
      ),
    ).toBe("t");
    updatedAt = data.updatedAt;
  });
  it("viewer 403, outsider 404, signed out 401, other tenant 404 for PATCH, DELETE and complete", async () => {
    const body = { expectedUpdatedAt: updatedAt };
    expect((await call(viewer, "PATCH", `/${id}`, { ...body, title: "Viewer edit" })).status).toBe(
      403,
    );
    expect((await call(viewer, "DELETE", `/${id}`)).status).toBe(403);
    expect(
      (await call(viewer, "POST", `/${id}/complete`, { ...body, completed: true })).status,
    ).toBe(403);
    expect((await call(outsider, "PATCH", `/${id}`, { ...body, title: "x y" })).status).toBe(404);
    expect((await call(other, "PATCH", `/${id}`, { ...body, title: "Hijack" }, orgB)).status).toBe(
      404,
    );
    expect((await call(other, "DELETE", `/${id}`, undefined, orgB)).status).toBe(404);
    expect(
      (await call(other, "POST", `/${id}/complete`, { ...body, completed: true }, orgB)).status,
    ).toBe(404);
    expect((await call(null, "POST", `/${id}/complete`, { ...body, completed: true })).status).toBe(
      401,
    );
    expect(psql(`select status from public.tasks where id = '${id}'`)).not.toBe("done");
  });

  describe("complete and reopen", () => {
    it("complete then reopen yields exactly two events; repeating either call yields none", async () => {
      const t = await fresh("Complete me", { status: "in_progress" });
      const done = await call(member, "POST", `/${t.id}/complete`, {
        completed: true,
        expectedUpdatedAt: t.updatedAt,
      });
      expect(done.status).toBe(200);
      const d = (await done.json()).data;
      expect(d).toMatchObject({ status: "done", dueState: "done" });
      expect(d.completedAt).not.toBeNull();
      expect(events(t.id)).toBe("completed");
      // repeating the same call: still 200, nothing new
      const again = await call(member, "POST", `/${t.id}/complete`, {
        completed: true,
        expectedUpdatedAt: d.updatedAt,
      });
      expect(again.status).toBe(200);
      expect((await again.json()).data.updatedAt).toBe(d.updatedAt);
      expect(events(t.id)).toBe("completed");
      const reopened = await call(member, "POST", `/${t.id}/complete`, {
        completed: false,
        expectedUpdatedAt: d.updatedAt,
      });
      const r = (await reopened.json()).data;
      expect(r).toMatchObject({ status: "todo", completedAt: null });
      expect(events(t.id)).toBe("completed,reopened");
      const reopenedAgain = await call(member, "POST", `/${t.id}/complete`, {
        completed: false,
        expectedUpdatedAt: r.updatedAt,
      });
      expect(reopenedAgain.status).toBe(200);
      expect(events(t.id)).toBe("completed,reopened");
      expect(
        psql(
          `select count(*) from public.activity_events where entity_id = '${t.id}' and action in ('completed', 'reopened') and actor_user_id = '${member.id}'`,
        ),
      ).toBe("2");
    });
    it("reopening can return the task to a chosen status; PATCH to done is a completion too", async () => {
      const t = await fresh("Reopen to blocked");
      const done = (
        await (
          await call(owner, "POST", `/${t.id}/complete`, {
            completed: true,
            expectedUpdatedAt: t.updatedAt,
          })
        ).json()
      ).data;
      const back = await call(owner, "POST", `/${t.id}/complete`, {
        completed: false,
        status: "blocked",
        expectedUpdatedAt: done.updatedAt,
      });
      expect((await back.json()).data.status).toBe("blocked");
      const viaPatch = await fresh("Done by patch");
      await call(owner, "PATCH", `/${viaPatch.id}`, {
        expectedUpdatedAt: viaPatch.updatedAt,
        status: "done",
      });
      expect(events(viaPatch.id)).toBe("completed");
    });
    it("a stale version is 409 and a bad body is 422", async () => {
      const t = await fresh("Stale complete");
      await call(owner, "PATCH", `/${t.id}`, { expectedUpdatedAt: t.updatedAt, priority: "low" });
      const stale = await call(member, "POST", `/${t.id}/complete`, {
        completed: true,
        expectedUpdatedAt: t.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect((await stale.json()).error.code).toBe("STALE_EDIT");
      expect(psql(`select status from public.tasks where id = '${t.id}'`)).toBe("todo");
      for (const body of [
        { expectedUpdatedAt: t.updatedAt },
        { completed: "yes", expectedUpdatedAt: t.updatedAt },
        { completed: true },
        { completed: false, status: "done", expectedUpdatedAt: t.updatedAt },
      ])
        expect(
          (await call(member, "POST", `/${t.id}/complete`, body)).status,
          JSON.stringify(body),
        ).toBe(422);
    });
  });

  it("DELETE archives (204, idempotent): the task leaves the default list but stays readable, with one archived event", async () => {
    const t = await fresh("Archive me");
    expect((await call(member, "DELETE", `/${t.id}`)).status).toBe(204);
    expect((await call(member, "DELETE", `/${t.id}`)).status).toBe(204);
    expect(psql(`select archived_at is not null from public.tasks where id = '${t.id}'`)).toBe("t");
    expect(await titles(await get(owner, "?limit=100"))).not.toContain("Archive me");
    const read = await call(owner, "GET", `/${t.id}`);
    expect((await read.json()).data.archivedAt).not.toBeNull();
    expect(events(t.id)).toBe("archived");
  });
  // The patterns are whole phrases: bare digits like 4711 or 9999 can appear by chance in a test user's generated name.
  it("editing never leaks description text into the activity log", async () => {
    const t = await fresh("Private task", { description: "secret gate code 4711" });
    await call(owner, "PATCH", `/${t.id}`, {
      expectedUpdatedAt: t.updatedAt,
      description: "another secret 9999",
    });
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${t.id}' and (changes::text ~* 'secret gate|another secret|gate code 4711|secret 9999' or summary ~* 'secret gate|another secret|gate code 4711|secret 9999')`,
      ),
    ).toBe("0");
  });
});

describe("demo workspaces", () => {
  const demo = (method: string, path = "", body?: unknown) =>
    call(guest, method, path, body, demoOrg);

  it("the seeded 24 are listed, with overdue and due-today buckets, assigned to nobody-specific", async () => {
    const res = await demo("GET", "?limit=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(24);
    const overdue = await (await demo("GET", "?overdue=true&limit=100")).json();
    expect(overdue.meta.total).toBe(5);
    expect(overdue.data.every((t: { dueState: string }) => t.dueState === "overdue")).toBe(true);
  });
  it("the 76th demo task fails with the cap error (429) and nothing is written", async () => {
    for (let i = 0; i < 51; i++)
      expect((await demo("POST", "", { title: `Cap task ${i}` })).status).toBe(201);
    const res = await demo("POST", "", { title: "Cap task over" });
    expect(res.status).toBe(429);
    expect(count(demoOrg)).toBe(75);
  });
  it("an expired demo is read-only: writes are 403 DEMO_EXPIRED and change nothing", async () => {
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${demoOrg}'`,
    );
    const res = await demo("POST", "", { title: "Too late" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("DEMO_EXPIRED");
    expect(count(demoOrg)).toBe(75);
  });
});
