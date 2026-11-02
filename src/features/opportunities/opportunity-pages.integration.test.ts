import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-236] The opportunity pages over real HTTP, and the form's money round trip through the API and the database. */
const server = new RealServer();
let owner: Actor, viewer: Actor, other: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let acme = "";
let foreign = "";
let dealId = "";
let foreignDeal = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const page = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");
const api = (actor: Actor, method: string, path: string, json?: unknown, org = orgA) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: hdr(org) });

beforeAll(async () => {
  await server.start();
  [owner, viewer, other, guest] = await Promise.all([
    server.member("of-owner"),
    server.member("of-viewer"),
    server.member("of-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  orgA = await mk(owner, "Deal Form Co A");
  orgB = await mk(other, "Deal Form Co B");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${orgA}', '${viewer.id}', 'viewer')`,
  );
  acme = (await (await api(owner, "POST", "/customers", { displayName: "Acme Forms" })).json()).data
    .id;
  foreign = (
    await (await api(other, "POST", "/customers", { displayName: "Globex Secret" }, orgB)).json()
  ).data.id;
  dealId = (
    await (
      await api(owner, "POST", "/opportunities", {
        customerId: acme,
        title: "Detail Subject",
        amountCents: 123450,
        stage: "proposal",
        description: "Scope & timing: 5 < 10",
      })
    ).json()
  ).data.id;
  foreignDeal = (
    await (
      await api(
        other,
        "POST",
        "/opportunities",
        { customerId: foreign, title: "Foreign Deal" },
        orgB,
      )
    ).json()
  ).data.id;
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

describe("/app/opportunities/new", () => {
  it("an owner and a demo guest get the form with every field labelled", async () => {
    for (const actor of [owner, guest]) {
      const html = await page("/app/opportunities/new", actor);
      expect(html).toContain("<form");
      for (const label of [
        "Customer",
        "Title",
        "Stage",
        "Amount",
        "Probability",
        "Expected close date",
        "Owner",
        "Description",
      ])
        expect(html, label).toContain(label);
    }
  });
  it("?customerId= starts with that customer when it is visible; another workspace's id is ignored and never leaks its name", async () => {
    expect(await page(`/app/opportunities/new?customerId=${acme}`, owner)).toContain(
      'value="Acme Forms"',
    );
    const html = await page(`/app/opportunities/new?customerId=${foreign}`, owner);
    expect(html).not.toContain("Globex Secret");
    expect(html).toContain("<form");
    expect(await page("/app/opportunities/new?customerId=not-an-id", owner)).toContain("<form");
  });
  it("a viewer gets a read-only message and no form", async () => {
    const html = await page("/app/opportunities/new", viewer);
    expect(html).toContain("You can view opportunities but not add them");
    expect(html).not.toContain("<form");
  });
});

describe("/app/opportunities/:id and /edit", () => {
  it("the detail page shows the deal with amount, weighted value and its customer; an owner sees Edit and the stage control, a viewer does not", async () => {
    const html = await page(`/app/opportunities/${dealId}`, owner);
    expect(html).toContain("Detail Subject");
    expect(html).toContain("$1,234.50");
    expect(html).toContain("$617.25");
    expect(html).toContain("Acme Forms");
    expect(html).toContain("Scope &amp; timing: 5 &lt; 10");
    expect(html).toContain(`/app/opportunities/${dealId}/edit`);
    expect(html).toContain('id="stage-control"');
    const v = await page(`/app/opportunities/${dealId}`, viewer);
    expect(v).toContain("Detail Subject");
    expect(v).not.toContain('id="stage-control"');
    expect(v).not.toContain(`/app/opportunities/${dealId}/edit`);
  });
  it("another workspace's deal, an unknown id and a malformed id are the same not-found page on both routes", async () => {
    for (const path of [
      `/app/opportunities/${foreignDeal}`,
      `/app/opportunities/${foreignDeal}/edit`,
      `/app/opportunities/${crypto.randomUUID()}`,
      "/app/opportunities/nope",
      "/app/opportunities/nope/edit",
    ]) {
      const html = await page(path, owner);
      expect(html, path).toContain("This record does not exist, or you do not have access to it.");
      expect(html, path).not.toContain("Foreign Deal");
    }
  });
  it("the edit page has the form for an owner and the read-only message for a viewer", async () => {
    expect(await page(`/app/opportunities/${dealId}/edit`, owner)).toContain("<form");
    const v = await page(`/app/opportunities/${dealId}/edit`, viewer);
    expect(v).toContain("You can view opportunities but not edit them");
    expect(v).not.toContain("<form");
  });
});

describe("what the form sends is accepted, shows up on the board and list, and round-trips exactly", () => {
  it("1,234.50 is 123450 cents in the database; an edit that leaves the amount alone keeps it; the board totals and the list include it", async () => {
    const created = await api(owner, "POST", "/opportunities", {
      customerId: acme,
      title: "Form Made",
      description: null,
      stage: "qualified",
      amountCents: 123450,
      expectedCloseDate: "2027-01-15",
      assignedTo: owner.id,
    });
    expect(created.status).toBe(201);
    const d = (await created.json()).data;
    expect(psql(`select amount_cents from public.opportunities where id = '${d.id}'`)).toBe(
      "123450",
    );
    const list = await (await api(owner, "GET", "/opportunities?q=Form%20Made")).json();
    expect(list.data.map((x: { id: string }) => x.id)).toContain(d.id);
    expect(list.meta.stageTotals.qualified).toEqual({ count: 1, amountCents: 123450 });
    const patched = await api(owner, "PATCH", `/opportunities/${d.id}`, {
      customerId: acme,
      title: "Form Made",
      description: null,
      amountCents: 123450,
      expectedCloseDate: "2027-01-15",
      assignedTo: owner.id,
      expectedUpdatedAt: d.updatedAt,
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).data.amountCents).toBe(123450);
    expect(psql(`select amount_cents from public.opportunities where id = '${d.id}'`)).toBe(
      "123450",
    );
  });
  it("a seeded demo customer can be given an opportunity, and it appears in the demo's list", async () => {
    const customers = await (
      await server.request("/api/v1/customers?limit=1&sort=display_name&order=asc", guest)
    ).json();
    const res = await server.request("/api/v1/opportunities", guest, {
      json: { customerId: customers.data[0].id, title: "Guest Form Deal", amountCents: 50000 },
    });
    expect(res.status).toBe(201);
    const list = await (await server.request("/api/v1/opportunities?q=Guest%20Form", guest)).json();
    expect(list.meta.total).toBe(1);
  });
  it("tampering with the customer id is a handled 404, nothing is written", async () => {
    const before = psql(
      `select count(*) from public.opportunities where organization_id = '${orgA}'`,
    );
    const res = await api(owner, "POST", "/opportunities", {
      customerId: foreign,
      title: "Tampered",
      amountCents: 1,
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("CUSTOMER_NOT_FOUND");
    expect(
      psql(`select count(*) from public.opportunities where organization_id = '${orgA}'`),
    ).toBe(before);
  });
});
