import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PROBABILITY,
  pipelineTotal,
  totalsByStage,
  weightedPipeline,
  type Stage,
} from "@/lib/domain/pipeline";
import { addDays, isDueSoon, isOverdue, todayInZone } from "@/lib/domain/tasks";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-244] GET /api/v1/dashboard against the real production build and Supabase: the envelope and access rules, that every
 * number follows the stored data (and the next response follows a change), tenant isolation, and parity between the SQL
 * function and the TypeScript domain modules (pipeline math and the organization-time task rules) in nine time zones.
 */
const server = new RealServer();
let owner: Actor, viewer: Actor, other: Actor, outsider: Actor, guest: Actor;
let org = "";
let orgB = "";
const hdr = (o: string) => ({ "X-Organization-Id": o });
const get = (actor: Actor | null, o = org) =>
  server.request("/api/v1/dashboard", actor, { headers: hdr(o) });
const api = (actor: Actor, method: string, path: string, json?: unknown, o = org) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: hdr(o) });
const dash = async (actor: Actor = owner, o = org) => (await (await get(actor, o)).json()).data;

type Deal = { stage: Stage; amount: number; probability: number; archived?: boolean };

/** Inserts customers/deals/tasks straight into a workspace (as the database owner) for exact-number fixtures. */
function seed(o: string, deals: Deal[]) {
  const customer = psql(
    `insert into public.customers (organization_id, display_name) values ('${o}', 'Fixture ' || substr(gen_random_uuid()::text, 1, 6)) returning id`,
  ).split("\n")[0];
  deals.forEach((d, i) => {
    const closed = d.stage === "won" || d.stage === "lost";
    psql(
      `insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, archived_at, closed_at, lost_reason)
       values ('${o}', '${customer}', 'Deal ${i}', '${d.stage}', ${d.amount}, ${d.probability}, ${d.archived ? "now()" : "null"}, ${closed ? "now()" : "null"}, ${d.stage === "lost" ? "'Price'" : "null"})`,
    );
  });
  return customer;
}

beforeAll(async () => {
  await server.start();
  [owner, viewer, other, outsider, guest] = await Promise.all([
    server.member("db-owner"),
    server.member("db-viewer"),
    server.member("db-other"),
    server.member("db-outsider"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string, timezone = "UTC") => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name, timezone } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  org = await mk(owner, "Dashboard Co");
  orgB = await mk(other, "Dashboard Other");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
  );
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/dashboard [SIT-244]", () => {
  it("401 signed out; 404 for a workspace the caller is not in; the same for an unknown one", async () => {
    expect((await get(null)).status).toBe(401);
    const res = await get(outsider);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/dashboard_summary|SELECT|organizations/i);
    expect((await get(owner, crypto.randomUUID())).status).toBe(404);
  });

  it("200 with the documented shape for an empty workspace: zeros, six stages, empty activity, labelled as current state", async () => {
    const res = await get(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const { data } = await res.json();
    expect(data).toMatchObject({
      basis: "current_state",
      timeZone: "UTC",
      activeCustomers: 0,
      openOpportunities: 0,
      pipelineCents: 0,
      weightedPipelineCents: 0,
      overdueTasks: 0,
      tasksDueNext7Days: 0,
      recentActivity: [],
    });
    expect(Object.keys(data.opportunitiesByStage)).toEqual([
      "new",
      "qualified",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ]);
    expect(Date.parse(data.generatedAt)).not.toBeNaN();
    expect(data.today).toBe(todayInZone(new Date(), "UTC"));
  });

  it("a viewer can read it", async () => {
    expect((await get(viewer)).status).toBe(200);
  });

  it("the next response follows the data: create, stage move, completion and archive each change the numbers", async () => {
    const customer = (
      await (await api(owner, "POST", "/customers", { displayName: "Dash Customer" })).json()
    ).data;
    let d = await dash();
    expect(d.activeCustomers).toBe(1);

    const deal = (
      await (
        await api(owner, "POST", "/opportunities", {
          customerId: customer.id,
          title: "Dash deal",
          amountCents: 250000,
          stage: "proposal",
        })
      ).json()
    ).data;
    d = await dash();
    expect(d).toMatchObject({
      openOpportunities: 1,
      pipelineCents: 250000,
      weightedPipelineCents: 125000,
    });
    expect(d.opportunitiesByStage.proposal).toEqual({ count: 1, amountCents: 250000 });

    const moved = await api(owner, "POST", `/opportunities/${deal.id}/stage`, {
      stage: "won",
      expectedUpdatedAt: deal.updatedAt,
    });
    expect(moved.status).toBe(200);
    d = await dash();
    expect(d).toMatchObject({ openOpportunities: 0, pipelineCents: 0, weightedPipelineCents: 0 });
    expect(d.opportunitiesByStage.won).toEqual({ count: 1, amountCents: 250000 });

    const yesterday = addDays(todayInZone(new Date(), "UTC"), -1);
    const task = (
      await (await api(owner, "POST", "/tasks", { title: "Late task", dueDate: yesterday })).json()
    ).data;
    expect((await dash()).overdueTasks).toBe(1);
    expect(
      (
        await api(owner, "POST", `/tasks/${task.id}/complete`, {
          completed: true,
          expectedUpdatedAt: task.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect((await dash()).overdueTasks).toBe(0);

    expect((await api(owner, "DELETE", `/customers/${customer.id}`)).status).toBe(204);
    expect((await dash()).activeCustomers).toBe(0);
    expect((await api(owner, "POST", `/customers/${customer.id}/restore`)).status).toBe(200);
    expect((await dash()).activeCustomers).toBe(1);
  });

  it("recentActivity is the newest 10 events of this workspace only, newest first, with the record they belong to", async () => {
    for (let i = 0; i < 12; i++)
      await api(owner, "POST", "/tasks", { title: `Activity task ${i}` });
    const { recentActivity } = await dash();
    expect(recentActivity).toHaveLength(10);
    const times = recentActivity.map((e: { createdAt: string }) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(recentActivity[0]).toMatchObject({ entityType: "task", action: "created" });
    expect(recentActivity[0].entityId).toBeTruthy();
    const ids = psql(
      `select string_agg(id::text, ',') from public.activity_events where organization_id = '${orgB}'`,
    );
    for (const e of recentActivity) expect(ids).not.toContain(e.id);
  });

  it("tenant isolation: each workspace sees only its own numbers, and B's data never appears in A's response", async () => {
    seed(orgB, [{ stage: "proposal", amount: 777_000_00, probability: 50 }]);
    const a = JSON.stringify(await dash());
    const b = await dash(other, orgB);
    expect(b).toMatchObject({ activeCustomers: 1, pipelineCents: 77_700_000 });
    expect(a).not.toContain("77700000");
    expect((await dash()).pipelineCents).toBe(0);
    // an A member asking for B is refused, not answered with zeros
    expect((await get(owner, orgB)).status).toBe(404);
  });

  it("a guest's first dashboard has meaningful numbers for every card", async () => {
    const data = (await (await server.request("/api/v1/dashboard", guest)).json()).data;
    expect(data.activeCustomers).toBe(15); // 18 seeded, 3 archived
    expect(data.openOpportunities).toBe(7);
    expect(data.pipelineCents).toBeGreaterThan(0);
    expect(data.weightedPipelineCents).toBeGreaterThan(0);
    expect(data.weightedPipelineCents).toBeLessThan(data.pipelineCents);
    expect(data.overdueTasks).toBeGreaterThan(0);
    expect(data.tasksDueNext7Days).toBeGreaterThan(0);
    expect(data.opportunitiesByStage.won.count).toBe(2);
    expect(data.opportunitiesByStage.lost.count).toBe(1);
    expect(data.recentActivity).toHaveLength(10);
  });
});

describe("SQL and TypeScript agree [SIT-244]", () => {
  const ZONES = [
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Asia/Kolkata",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "Pacific/Kiritimati",
    "Pacific/Pago_Pago",
  ];
  const DEALS: Deal[] = [
    { stage: "new", amount: 1, probability: 50 },
    { stage: "new", amount: 3, probability: 50 },
    { stage: "qualified", amount: 1_999_999, probability: 25 },
    { stage: "proposal", amount: 123_456_789, probability: 49 },
    { stage: "proposal", amount: 50, probability: 1 },
    { stage: "negotiation", amount: 9_007_199_254, probability: 75 },
    { stage: "won", amount: 400_000, probability: 100 },
    { stage: "lost", amount: 300_000, probability: 0 },
    { stage: "negotiation", amount: 888_888, probability: 75, archived: true },
  ];

  it("pipeline total, weighted pipeline and by-stage totals equal the domain module on the same rows", async () => {
    // a workspace needs its own owner: one account may create only a few workspaces
    const who = await server.member("db-parity-pipeline");
    const o = (
      await (
        await server.request("/api/v1/organizations", who, { json: { name: "Parity Pipeline" } })
      ).json()
    ).data.id as string;
    seed(o, DEALS);
    const live = DEALS.filter((d) => !d.archived).map((d) => ({
      stage: d.stage,
      amountCents: d.amount,
      probability: d.probability,
    }));
    const data = await dash(who, o);
    expect(data.pipelineCents).toBe(pipelineTotal(live));
    expect(data.weightedPipelineCents).toBe(weightedPipeline(live));
    expect(data.opportunitiesByStage).toEqual(totalsByStage(live));
    expect(DEFAULT_PROBABILITY.new).toBe(10); // the fixture sets probabilities explicitly; defaults are not what is under test
  });

  it("overdue and due-in-7-days equal the domain rules in every zone, with tasks on both sides of each local midnight", async () => {
    for (const zone of ZONES) {
      const who = await server.member(`db-parity-${zone.replace(/\W/g, "")}`);
      const o = (
        await (
          await server.request("/api/v1/organizations", who, {
            json: { name: `Parity ${zone}`, timezone: zone },
          })
        ).json()
      ).data.id as string;
      const now = new Date();
      const base = todayInZone(now, zone);
      const rows: Array<{ dueDate: string | null; status: string }> = [];
      for (let d = -4; d <= 10; d++)
        for (const status of ["todo", "blocked", "done"])
          rows.push({ dueDate: addDays(base, d), status });
      rows.push({ dueDate: null, status: "todo" });
      psql(
        `insert into public.tasks (organization_id, title, status, due_date) values ${rows
          .map(
            (r, i) => `('${o}', 'P${i}', '${r.status}', ${r.dueDate ? `'${r.dueDate}'` : "null"})`,
          )
          .join(",")}`,
      );
      const before = new Date();
      const data = await dash(who, o);
      const after = new Date();
      // the local date can only differ from `base` if midnight passed between the calls; skip that rare race
      if (todayInZone(before, zone) !== base || todayInZone(after, zone) !== base) continue;
      expect(data.timeZone).toBe(zone);
      expect(data.today, zone).toBe(base);
      expect(data.overdueTasks, zone).toBe(rows.filter((r) => isOverdue(r, now, zone)).length);
      expect(data.tasksDueNext7Days, zone).toBe(rows.filter((r) => isDueSoon(r, now, zone)).length);
      // the lists the dashboard cards link to hold exactly the counted tasks
      const list = async (qs: string) =>
        (
          await (
            await server.request(`/api/v1/tasks?${qs}&limit=100`, who, { headers: hdr(o) })
          ).json()
        ).meta.total as number;
      expect(await list("overdue=true"), `${zone} overdue list`).toBe(data.overdueTasks);
      expect(await list("dueSoon=true"), `${zone} due-soon list`).toBe(data.tasksDueNext7Days);
    }
  });
});
