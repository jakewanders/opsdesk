import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pipelineTotal, totalsByStage, weightedPipeline } from "@/lib/domain/pipeline";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** /api/v1/opportunities against the production build and the local stack, across roles and tenants (PRD 11.3). */
const server = new RealServer();
const PATH = "/api/v1/opportunities";
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
let globex = "";
let foreignCustomer = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const call = (actor: Actor | null, method: string, path = "", body?: unknown, org = orgA) =>
  server.request(`${PATH}${path}`, actor, { method, json: body, headers: hdr(org) });
const get = (actor: Actor | null, qs = "", org = orgA) => call(actor, "GET", qs, undefined, org);
const post = (actor: Actor | null, body: unknown, org = orgA) => call(actor, "POST", "", body, org);
const titles = async (res: Response) =>
  ((await res.json()).data as Array<{ title: string }>).map((o) => o.title);
const count = (org: string) =>
  Number(psql(`select count(*) from public.opportunities where organization_id = '${org}'`));

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
async function createCustomer(actor: Actor, org: string, displayName: string): Promise<string> {
  const res = await server.request("/api/v1/customers", actor, {
    json: { displayName },
    headers: hdr(org),
  });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, other, guest] = await Promise.all([
    server.member("op-owner"),
    server.member("op-admin"),
    server.member("op-member"),
    server.member("op-viewer"),
    server.member("op-outsider"),
    server.member("op-other"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Deals Co A");
  orgB = await createOrg(other, "Deals Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demoOrg = (await boot.json()).data.organizationId;
  acme = await createCustomer(owner, orgA, "Acme Plumbing");
  globex = await createCustomer(owner, orgA, "Globex Roofing");
  foreignCustomer = await createCustomer(other, orgB, "Foreign Customer");
}, 400_000);
afterAll(async () => {
  await server.stop();
});

describe("POST /opportunities", () => {
  it("creates a deal with defaults: stage new, amount 0, probability from the stage; and returns the customer's name", async () => {
    const res = await post(member, { customerId: acme, title: "  Minimal deal " });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data).toMatchObject({
      title: "Minimal deal",
      customerId: acme,
      customerName: "Acme Plumbing",
      stage: "new",
      amountCents: 0,
      probabilityPercent: 10,
      lostReason: null,
      closedAt: null,
      archivedAt: null,
    });
  });
  it("the probability follows the stage unless sent; an explicit 0 is kept", async () => {
    const proposal = (
      await (
        await post(owner, { customerId: acme, title: "Proposal deal", stage: "proposal" })
      ).json()
    ).data;
    expect(proposal.probabilityPercent).toBe(50);
    const explicit = (
      await (
        await post(owner, {
          customerId: acme,
          title: "Explicit deal",
          stage: "proposal",
          probabilityPercent: 0,
        })
      ).json()
    ).data;
    expect(explicit.probabilityPercent).toBe(0);
  });
  it("owner, admin and member can create; a viewer is 403 and nothing is written", async () => {
    for (const a of [owner, admin, member])
      expect((await post(a, { customerId: acme, title: `By ${a.id.slice(0, 4)}` })).status).toBe(
        201,
      );
    const before = count(orgA);
    const res = await post(viewer, { customerId: acme, title: "Viewer deal" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(count(orgA)).toBe(before);
  });
  it("signed out is 401; a non-member of the workspace is 404", async () => {
    expect((await post(null, { customerId: acme, title: "Nobody" })).status).toBe(401);
    expect((await post(outsider, { customerId: acme, title: "Outsider" })).status).toBe(404);
  });
  it("another tenant's customer is 404 CUSTOMER_NOT_FOUND (same as an unknown one) and nothing is written", async () => {
    const before = count(orgA);
    const foreign = await post(owner, { customerId: foreignCustomer, title: "Cross tenant" });
    const unknown = await post(owner, {
      customerId: crypto.randomUUID(),
      title: "Unknown customer",
    });
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("CUSTOMER_NOT_FOUND");
    expect(count(orgA)).toBe(before);
    expect(count(orgB)).toBe(0);
  });
  it("an assignee from another workspace or without membership is 422 and nothing is written", async () => {
    const before = count(orgA);
    for (const who of [other, outsider]) {
      const res = await post(owner, {
        customerId: acme,
        title: "Bad assignee",
        assignedTo: who.id,
      });
      expect(res.status).toBe(422);
    }
    expect(count(orgA)).toBe(before);
    expect(
      (await post(owner, { customerId: acme, title: "Good assignee", assignedTo: member.id }))
        .status,
    ).toBe(201);
  });
  it("validation: title, amount, probability, date, stage, unknown and forged fields are 422 with field errors", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["title", { title: "x" }],
      ["title", { title: "t".repeat(151) }],
      ["amountCents", { title: "Deal ok", amountCents: -5 }],
      ["amountCents", { title: "Deal ok", amountCents: 12.5 }],
      ["amountCents", { title: "Deal ok", amountCents: "100" }],
      ["probabilityPercent", { title: "Deal ok", probabilityPercent: 101 }],
      ["expectedCloseDate", { title: "Deal ok", expectedCloseDate: "2026-02-30" }],
      ["stage", { title: "Deal ok", stage: "won" }],
    ];
    for (const [field, extra] of bad) {
      const res = await post(owner, { customerId: acme, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(JSON.stringify((await res.json()).error)).toContain(field);
    }
    for (const forged of [
      { organizationId: orgB },
      { createdBy: member.id },
      { id: crypto.randomUUID() },
      { lostReason: "x" },
    ])
      expect((await post(owner, { customerId: acme, title: "Forged", ...forged })).status).toBe(
        422,
      );
    expect((await post(owner, { title: "No customer" })).status).toBe(422);
  });
  it("money stays integer cents end to end, up to the maximum", async () => {
    const res = await post(owner, {
      customerId: acme,
      title: "Big deal",
      amountCents: 100000000000,
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.amountCents).toBe(100000000000);
    expect(
      (await post(owner, { customerId: acme, title: "Too big", amountCents: 100000000001 })).status,
    ).toBe(422);
  });
  it("creating is recorded: a created event by the actor, in the same transaction", async () => {
    const id = (await (await post(admin, { customerId: acme, title: "Logged deal" })).json()).data
      .id;
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${id}' and action = 'created' and entity_type = 'opportunity' and actor_user_id = '${admin.id}'`,
      ),
    ).toBe("1");
  });
});

describe("GET /opportunities (list, filters, search, totals)", () => {
  const fixture = [
    {
      title: "Alpha retrofit",
      customerId: "acme",
      stage: "new",
      amountCents: 100000,
      expectedCloseDate: "2026-12-05",
    },
    {
      title: "Beta boiler",
      customerId: "acme",
      stage: "qualified",
      amountCents: 250000,
      expectedCloseDate: "2026-12-20",
    },
    {
      title: "Gamma 100% roof_top",
      customerId: "globex",
      stage: "proposal",
      amountCents: 750000,
      probabilityPercent: 60,
    },
    {
      title: "Delta, (comma) deal",
      customerId: "globex",
      stage: "negotiation",
      amountCents: 1250000,
      expectedCloseDate: "2027-01-15",
    },
  ];
  let org = "";
  beforeAll(async () => {
    org = await createOrg(owner, "Deals Fixture Co");
    addMember(org, viewer, "viewer");
    const a = await createCustomer(owner, org, "Acme Plumbing");
    const g = await createCustomer(owner, org, "Globex Roofing");
    for (const f of fixture)
      expect(
        (await post(owner, { ...f, customerId: f.customerId === "acme" ? a : g }, org)).status,
      ).toBe(201);
    // a won and a lost deal, with archived and closed values set directly (the stage endpoint is a later issue)
    psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, closed_at) values
      ('${org}', '${a}', 'Epsilon won', 'won', 900000, 100, now())`);
    psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, closed_at, lost_reason) values
      ('${org}', '${g}', 'Zeta lost', 'lost', 400000, now(), 'Price')`);
    psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, archived_at) values
      ('${org}', '${a}', 'Eta archived', 'new', 50000, now())`);
  }, 120_000);

  it("pages with meta, hides archived by default, and a viewer can read", async () => {
    const res = await get(viewer, "?limit=3&sort=title&order=asc", org);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((o: { title: string }) => o.title)).toEqual([
      "Alpha retrofit",
      "Beta boiler",
      "Delta, (comma) deal",
    ]);
    expect(body.meta).toMatchObject({ page: 1, limit: 3, total: 6, totalPages: 2 });
    expect(await titles(await get(owner, "?limit=3&page=2&sort=title&order=asc", org))).toEqual([
      "Epsilon won",
      "Gamma 100% roof_top",
      "Zeta lost",
    ]);
    expect(await titles(await get(owner, "?archived=true", org))).toEqual(["Eta archived"]);
    expect((await get(owner, "?archived=all", org).then((r) => r.json())).meta.total).toBe(7);
  });
  it("a page past the end is empty with the real total and totals", async () => {
    const body = await (await get(owner, "?page=9", org)).json();
    expect(body.data).toEqual([]);
    expect(body.meta.total).toBe(6);
    expect(body.meta.openPipelineCents).toBeGreaterThan(0);
  });
  it("meta stage totals and pipeline sums match the pipeline domain module on the fixture", async () => {
    const { meta } = await (await get(owner, "", org)).json();
    const rows = [
      { stage: "new", amountCents: 100000, probability: 10 },
      { stage: "qualified", amountCents: 250000, probability: 25 },
      { stage: "proposal", amountCents: 750000, probability: 60 },
      { stage: "negotiation", amountCents: 1250000, probability: 75 },
      { stage: "won", amountCents: 900000, probability: 100 },
      { stage: "lost", amountCents: 400000, probability: 0 },
    ] as const;
    expect(meta.stageTotals).toEqual(totalsByStage([...rows]));
    expect(meta.openPipelineCents).toBe(pipelineTotal([...rows]));
    expect(meta.weightedPipelineCents).toBe(weightedPipeline([...rows]));
    expect(meta.openPipelineCents).toBe(2350000);
    expect(meta.aggregatesComplete).toBe(true);
    // totals follow the filters, and cover the whole set, not just the page
    const filtered = await (await get(owner, "?stage=proposal&limit=1", org)).json();
    expect(filtered.meta.stageTotals.proposal).toEqual({ count: 1, amountCents: 750000 });
    expect(filtered.meta.stageTotals.new.count).toBe(0);
    const paged = await (await get(owner, "?limit=1", org)).json();
    expect(paged.meta.stageTotals).toEqual(meta.stageTotals);
  });
  it("filters by stage, customer, owner-less, and expected close date range", async () => {
    expect(await titles(await get(owner, "?stage=qualified", org))).toEqual(["Beta boiler"]);
    const customers = (
      await (
        await server.request("/api/v1/customers?sort=display_name&order=asc", owner, {
          headers: hdr(org),
        })
      ).json()
    ).data;
    const acmeId = customers[0].id as string;
    expect(
      await titles(await get(owner, `?customerId=${acmeId}&sort=title&order=asc`, org)),
    ).toEqual(["Alpha retrofit", "Beta boiler", "Epsilon won"]);
    expect(await titles(await get(owner, "?closeFrom=2026-12-10&closeTo=2026-12-31", org))).toEqual(
      ["Beta boiler"],
    );
    expect(
      await titles(
        await get(owner, "?closeFrom=2026-12-05&closeTo=2026-12-20&sort=title&order=asc", org),
      ),
    ).toEqual(["Alpha retrofit", "Beta boiler"]);
    expect(await titles(await get(owner, `?assignedTo=${member.id}`, org))).toEqual([]);
  });
  it("searches deal titles and customer names, treating the text literally", async () => {
    expect(await titles(await get(owner, "?q=globex&sort=title&order=asc", org))).toEqual([
      "Delta, (comma) deal",
      "Gamma 100% roof_top",
      "Zeta lost",
    ]);
    expect(await titles(await get(owner, "?q=BOILER", org))).toEqual(["Beta boiler"]);
    expect(
      await titles(await get(owner, `?q=${encodeURIComponent("100% roof_top")}`, org)),
    ).toEqual(["Gamma 100% roof_top"]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("%")}`, org))).toEqual([
      "Gamma 100% roof_top",
    ]);
    expect(await titles(await get(owner, `?q=${encodeURIComponent("_")}`, org))).toEqual([
      "Gamma 100% roof_top",
    ]);
    expect(
      await titles(await get(owner, `?q=${encodeURIComponent("Delta, (comma)")}`, org)),
    ).toEqual(["Delta, (comma) deal"]);
    expect(
      await titles(await get(owner, `?q=${encodeURIComponent('") or true --')}`, org)),
    ).toEqual([]);
    expect(await titles(await get(owner, "?q=nothing-matches-this", org))).toEqual([]);
  });
  it("sorts by the whitelist (amount, null dates last) and refuses anything else", async () => {
    expect(await titles(await get(owner, "?sort=amount_cents&order=desc&limit=2", org))).toEqual([
      "Delta, (comma) deal",
      "Epsilon won",
    ]);
    expect(
      (await titles(await get(owner, "?sort=expected_close_date&order=asc&limit=3", org))).slice(
        0,
        3,
      ),
    ).toEqual(["Alpha retrofit", "Beta boiler", "Delta, (comma) deal"]);
    for (const qs of [
      "?sort=organization_id",
      "?sort=title;drop",
      "?stage=bogus",
      "?limit=101",
      "?page=0",
      "?closeFrom=nope",
      "?unknown=1",
    ])
      expect((await get(owner, qs, org)).status, qs).toBe(422);
  });
  it("never returns another tenant's deals, and a non-member is 404", async () => {
    expect(await titles(await get(other, "", orgB))).toEqual([]);
    expect((await get(outsider, "", org)).status).toBe(404);
    expect((await get(null, "", org)).status).toBe(401);
    const aTitles = await titles(await get(owner, "?limit=100"));
    expect(aTitles.some((t) => t.includes("Alpha retrofit"))).toBe(false);
  });
});

describe("GET/PATCH/DELETE /opportunities/:id", () => {
  let id = "";
  let updatedAt = "";
  beforeAll(async () => {
    const d = (
      await (
        await post(owner, {
          customerId: acme,
          title: "Detail subject",
          amountCents: 500000,
          description: "private site notes",
        })
      ).json()
    ).data;
    id = d.id;
    updatedAt = d.updatedAt;
  });

  it("GET returns the deal; a viewer can read; a missing id and another tenant's id are the same 404; a bad id is 400", async () => {
    const res = await call(viewer, "GET", `/${id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      id,
      title: "Detail subject",
      customerName: "Acme Plumbing",
    });
    const missing = await call(owner, "GET", `/${crypto.randomUUID()}`);
    const foreign = await call(other, "GET", `/${id}`, undefined, orgB);
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect((await missing.json()).error.code).toBe((await foreign.json()).error.code);
    expect((await call(owner, "GET", "/not-a-uuid")).status).toBe(400);
  });
  it("PATCH rejects `stage` with a clear message and changes nothing", async () => {
    for (const stage of ["won", "lost", "qualified", null]) {
      const res = await call(member, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, stage });
      expect(res.status).toBe(422);
      expect(JSON.stringify((await res.json()).error)).toContain("/stage");
    }
    expect(psql(`select stage from public.opportunities where id = '${id}'`)).toBe("new");
  });
  it("PATCH updates fields, returns the new version, and the old version is then stale (409 with the current one)", async () => {
    const res = await call(member, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      title: "Detail subject v2",
      amountCents: 750000,
      expectedCloseDate: "2027-02-01",
      probabilityPercent: 40,
      assignedTo: admin.id,
    });
    expect(res.status).toBe(200);
    const next = (await res.json()).data;
    expect(next).toMatchObject({
      title: "Detail subject v2",
      amountCents: 750000,
      expectedCloseDate: "2027-02-01",
      probabilityPercent: 40,
      assignedTo: admin.id,
      stage: "new",
    });
    expect(next.updatedAt).not.toBe(updatedAt);
    const stale = await call(admin, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      title: "Lost update",
    });
    expect(stale.status).toBe(409);
    const body = await stale.json();
    expect(body.error.code).toBe("STALE_EDIT");
    expect(body.error.meta.current.updatedAt).toBe(next.updatedAt);
    expect(psql(`select title from public.opportunities where id = '${id}'`)).toBe(
      "Detail subject v2",
    );
    updatedAt = next.updatedAt;
  });
  it("two simultaneous edits: exactly one wins and the other is 409", async () => {
    const [a, b] = await Promise.all([
      call(owner, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, title: "Race A" }),
      call(admin, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, title: "Race B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "Race A" : "Race B";
    expect(psql(`select title from public.opportunities where id = '${id}'`)).toBe(winner);
    const cur = psql(
      `select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') from public.opportunities where id = '${id}'`,
    );
    updatedAt = (await (await call(owner, "GET", `/${id}`)).json()).data.updatedAt;
    expect(cur.length).toBeGreaterThan(10);
  });
  it("a patch that changes nothing is 200, writes nothing and logs nothing", async () => {
    const title = psql(`select title from public.opportunities where id = '${id}'`);
    const eventsBefore = psql(
      `select count(*) from public.activity_events where entity_id = '${id}'`,
    );
    const res = await call(member, "PATCH", `/${id}`, { expectedUpdatedAt: updatedAt, title });
    expect(res.status).toBe(200);
    expect((await res.json()).data.updatedAt).toBe(updatedAt);
    expect(psql(`select count(*) from public.activity_events where entity_id = '${id}'`)).toBe(
      eventsBefore,
    );
  });
  it("clearing optional fields works; moving to another customer of the workspace works; another tenant's customer is 404", async () => {
    const cleared = await call(owner, "PATCH", `/${id}`, {
      expectedUpdatedAt: updatedAt,
      expectedCloseDate: null,
      assignedTo: null,
      description: "",
    });
    expect(cleared.status).toBe(200);
    const data = (await cleared.json()).data;
    expect(data).toMatchObject({ expectedCloseDate: null, assignedTo: null, description: null });
    const moved = await call(owner, "PATCH", `/${id}`, {
      expectedUpdatedAt: data.updatedAt,
      customerId: globex,
    });
    expect(moved.status).toBe(200);
    expect((await moved.json()).data.customerName).toBe("Globex Roofing");
    const cur = (await (await call(owner, "GET", `/${id}`)).json()).data.updatedAt;
    const cross = await call(owner, "PATCH", `/${id}`, {
      expectedUpdatedAt: cur,
      customerId: foreignCustomer,
    });
    expect(cross.status).toBe(404);
    expect(psql(`select customer_id from public.opportunities where id = '${id}'`)).toBe(globex);
    const badAssignee = await call(owner, "PATCH", `/${id}`, {
      expectedUpdatedAt: cur,
      assignedTo: other.id,
    });
    expect(badAssignee.status).toBe(422);
  });
  it("refuses forged and unknown fields", async () => {
    const cur = (await (await call(owner, "GET", `/${id}`)).json()).data.updatedAt;
    for (const forged of [
      { organizationId: orgB },
      { createdBy: member.id },
      { id: crypto.randomUUID() },
      { lostReason: "x" },
      { closedAt: "2026-01-01T00:00:00Z" },
      { whatever: 1 },
    ])
      expect(
        (await call(owner, "PATCH", `/${id}`, { expectedUpdatedAt: cur, ...forged })).status,
      ).toBe(422);
  });
  it("a viewer is 403 and an outsider 404 for PATCH and DELETE; another tenant cannot touch the deal", async () => {
    const cur = (await (await call(owner, "GET", `/${id}`)).json()).data.updatedAt;
    expect(
      (await call(viewer, "PATCH", `/${id}`, { expectedUpdatedAt: cur, title: "Viewer edit" }))
        .status,
    ).toBe(403);
    expect((await call(viewer, "DELETE", `/${id}`)).status).toBe(403);
    expect(
      (await call(outsider, "PATCH", `/${id}`, { expectedUpdatedAt: cur, title: "x y" })).status,
    ).toBe(404);
    expect(
      (await call(other, "PATCH", `/${id}`, { expectedUpdatedAt: cur, title: "Hijack" }, orgB))
        .status,
    ).toBe(404);
    expect((await call(other, "DELETE", `/${id}`, undefined, orgB)).status).toBe(404);
    expect(
      (await call(null, "PATCH", `/${id}`, { expectedUpdatedAt: cur, title: "x y" })).status,
    ).toBe(401);
    expect(psql(`select title from public.opportunities where id = '${id}'`)).not.toMatch(
      /Viewer edit|Hijack/,
    );
  });
  it("DELETE archives (204, idempotent), the deal leaves the default list but stays readable, and nothing is hard-deleted", async () => {
    expect((await call(member, "DELETE", `/${id}`)).status).toBe(204);
    expect((await call(member, "DELETE", `/${id}`)).status).toBe(204);
    expect(
      psql(`select archived_at is not null from public.opportunities where id = '${id}'`),
    ).toBe("t");
    expect(await titles(await get(owner, "?limit=100"))).not.toContain("Race A");
    const read = await call(owner, "GET", `/${id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).data.archivedAt).not.toBeNull();
    expect(
      psql(
        `select string_agg(action, ',' order by created_at, id) from public.activity_events where entity_id = '${id}' and action in ('archived', 'restored')`,
      ),
    ).toBe("archived");
  });
  it("editing never leaks description text into the activity log", async () => {
    const d = (
      await (
        await post(owner, {
          customerId: acme,
          title: "Private deal",
          description: "secret gate code 4711",
        })
      ).json()
    ).data;
    await call(owner, "PATCH", `/${d.id}`, {
      expectedUpdatedAt: d.updatedAt,
      description: "another secret 9999",
    });
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${d.id}' and (changes::text ~* 'secret|4711|9999' or summary ~* 'secret|4711|9999')`,
      ),
    ).toBe("0");
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${d.id}' and changes ? '_content_changed'`,
      ),
    ).toBe("1");
  });
});

describe("demo workspaces", () => {
  const demo = (method: string, path = "", body?: unknown) =>
    call(guest, method, path, body, demoOrg);

  it("a guest can use their demo workspace; the seeded deals are listed with totals", async () => {
    const res = await demo("GET", "?limit=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(10);
    expect(body.meta.stageTotals.won.count).toBe(2);
    expect(body.data.every((o: { customerName: string | null }) => o.customerName)).toBe(true);
  });
  it("the 31st demo opportunity fails with the cap error (429) and nothing is written", async () => {
    const customer = (await (await demo("GET", "?limit=1")).json()).data[0].customerId as string;
    for (let i = 0; i < 20; i++)
      expect(
        (await demo("POST", "", { customerId: customer, title: `Cap deal ${i}` })).status,
      ).toBe(201);
    const res = await demo("POST", "", { customerId: customer, title: "Cap deal 21" });
    expect(res.status).toBe(429);
    expect(count(demoOrg)).toBe(30);
  });
  it("an expired demo is read-only: writes are 403 DEMO_EXPIRED and change nothing", async () => {
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${demoOrg}'`,
    );
    const customer = psql(
      `select customer_id from public.opportunities where organization_id = '${demoOrg}' limit 1`,
    );
    const res = await demo("POST", "", { customerId: customer, title: "Too late" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("DEMO_EXPIRED");
    expect(count(demoOrg)).toBe(30);
  });
});
