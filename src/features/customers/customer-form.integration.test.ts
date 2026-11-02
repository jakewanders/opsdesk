import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-225] The members endpoint behind the owner picker, and the add / edit pages over real HTTP. */
const server = new RealServer();
let owner: Actor, viewer: Actor, outsider: Actor, other: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let customerA = "";
let customerB = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const text = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

beforeAll(async () => {
  await server.start();
  [owner, viewer, outsider, other, guest] = await Promise.all([
    server.member("cf-owner"),
    server.member("cf-viewer"),
    server.member("cf-outsider"),
    server.member("cf-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  orgA = await mk(owner, "Form Co A");
  orgB = await mk(other, "Form Co B");
  addMember(orgA, viewer, "viewer");
  psql(`update public.profiles set display_name = 'Olivia Owner' where id = '${owner.id}'`);
  psql(`update public.profiles set display_name = 'Vic Viewer' where id = '${viewer.id}'`);
  psql(`update public.profiles set display_name = 'Otto Other' where id = '${other.id}'`);
  const c = async (actor: Actor, org: string, displayName: string) =>
    (
      await (
        await server.request("/api/v1/customers", actor, {
          json: {
            displayName,
            email: `${displayName.replace(/\W/g, "").toLowerCase()}@example.com`,
          },
          headers: hdr(org),
        })
      ).json()
    ).data.id as string;
  customerA = await c(owner, orgA, "Acme Forms");
  customerB = await c(other, orgB, "Globex Forms");
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/members", () => {
  it("lists exactly this workspace's people with id, role and display name, sorted by name, and nothing else", async () => {
    const res = await server.request("/api/v1/members", viewer, { headers: hdr(orgA) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(
      body.data.map((m: { displayName: string; role: string }) => `${m.displayName}:${m.role}`),
    ).toEqual(["Olivia Owner:owner", "Vic Viewer:viewer"]);
    expect(Object.keys(body.data[0]).sort()).toEqual(["displayName", "role", "userId"]);
    expect(body.meta.total).toBe(2);
    expect(JSON.stringify(body)).not.toMatch(/@example\.test|Otto/);
  });
  it("never shows another workspace's people; a non-member is 404, signed out is 401", async () => {
    const mine = await (
      await server.request("/api/v1/members", other, { headers: hdr(orgB) })
    ).json();
    expect(mine.data.map((m: { displayName: string }) => m.displayName)).toEqual(["Otto Other"]);
    expect((await server.request("/api/v1/members", other, { headers: hdr(orgA) })).status).toBe(
      404,
    );
    expect((await server.request("/api/v1/members", outsider, { headers: hdr(orgA) })).status).toBe(
      404,
    );
    expect((await server.request("/api/v1/members", null, { headers: hdr(orgA) })).status).toBe(
      401,
    );
  });
  it("a demo guest sees the people of their own demo workspace only", async () => {
    const res = await server.request("/api/v1/members", guest);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(1);
    expect((await server.request("/api/v1/members", guest, { headers: hdr(orgA) })).status).toBe(
      404,
    );
  });
});

describe("/app/customers/new", () => {
  it("an owner gets the form with every field labelled", async () => {
    const html = await text("/app/customers/new", owner);
    expect(html).toContain("Add customer");
    for (const label of [
      "Display name",
      "Company",
      "Email",
      "Phone",
      "Website",
      "Status",
      "Source",
      "Owner",
      "Tags",
      "Notes",
    ])
      expect(html, label).toContain(label);
    expect(html).toContain("<form");
  });
  it("a viewer gets a read-only message and no form", async () => {
    const html = await text("/app/customers/new", viewer);
    expect(html).toContain("You can view customers but not add them");
    expect(html).not.toContain("<form");
  });
  it("a demo guest can add customers", async () => {
    expect(await text("/app/customers/new", guest)).toContain("<form");
  });
});

describe("/app/customers/:id/edit", () => {
  it("an owner gets the form filled with the customer", async () => {
    const html = await text(`/app/customers/${customerA}/edit`, owner);
    expect(html).toContain("Edit Acme Forms");
    expect(html).toContain("<form");
  });
  it("another workspace's customer, an unknown id and a malformed id are all the same not-found page", async () => {
    for (const path of [
      `/app/customers/${customerB}/edit`,
      `/app/customers/${crypto.randomUUID()}/edit`,
      "/app/customers/nope/edit",
    ]) {
      const html = await text(path, owner);
      expect(html, path).toContain("This record does not exist, or you do not have access to it.");
      expect(html, path).not.toContain("Globex Forms");
      expect(html, path).not.toContain("<form");
    }
  });
  it("a viewer gets a read-only message and no form", async () => {
    const html = await text(`/app/customers/${customerA}/edit`, viewer);
    expect(html).toContain("You can view customers but not edit them");
    expect(html).not.toContain("<form");
  });
});

describe("what the form sends is accepted by the API and appears in the list", () => {
  it("a normalized create persists, appears in the list, and an edit with the loaded version succeeds then a stale one is 409", async () => {
    const created = await server.request("/api/v1/customers", owner, {
      json: {
        type: "person",
        displayName: "Form Made",
        companyName: null,
        email: "form.made@example.com",
        phone: null,
        website: null,
        status: "active",
        source: "referral",
        tags: ["vip"],
        notes: null,
        assignedTo: owner.id,
      },
      headers: hdr(orgA),
    });
    expect(created.status).toBe(201);
    const c = (await created.json()).data;
    const list = await (
      await server.request("/api/v1/customers?q=form.made", owner, { headers: hdr(orgA) })
    ).json();
    expect(list.data.map((x: { id: string }) => x.id)).toContain(c.id);
    const patch = (version: string, name: string) =>
      server.request(`/api/v1/customers/${c.id}`, owner, {
        method: "PATCH",
        json: {
          type: "person",
          displayName: name,
          companyName: null,
          email: "form.made@example.com",
          phone: null,
          website: null,
          status: "active",
          source: "referral",
          tags: ["vip"],
          notes: null,
          assignedTo: owner.id,
          expectedUpdatedAt: version,
        },
        headers: hdr(orgA),
      });
    const ok = await patch(c.updatedAt, "Form Made Two");
    expect(ok.status).toBe(200);
    expect((await patch(c.updatedAt, "Form Made Three")).status).toBe(409);
  });
  it("an owner from another workspace is refused by the database (422), so the picker's list is the only way in", async () => {
    const res = await server.request("/api/v1/customers", owner, {
      json: { displayName: "Bad Owner", assignedTo: other.id },
      headers: hdr(orgA),
    });
    expect(res.status).toBe(422);
  });
});
