import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** GET/POST /api/v1/customers against the production build and the local stack, across roles and tenants (PRD 11.3). */
const server = new RealServer();
const PATH = "/api/v1/customers";
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

const hdr = (org: string) => ({ "X-Organization-Id": org });
const get = (actor: Actor | null, qs = "", org = orgA) =>
  server.request(`${PATH}${qs}`, actor, { headers: hdr(org) });
const post = (actor: Actor | null, body: unknown, org = orgA) =>
  server.request(PATH, actor, { json: body, headers: hdr(org) });
const names = async (res: Response) =>
  ((await res.json()).data as Array<{ displayName: string }>).map((c) => c.displayName);

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
  [owner, admin, member, viewer, outsider, other, guest] = await Promise.all([
    server.member("cu-owner"),
    server.member("cu-admin"),
    server.member("cu-member"),
    server.member("cu-viewer"),
    server.member("cu-outsider"),
    server.member("cu-other"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Customer Co A");
  orgB = await createOrg(other, "Customer Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demoOrg = (await boot.json()).data.organizationId;

  // known data
  for (const body of [
    {
      displayName: "Acme Plumbing",
      type: "company",
      status: "active",
      source: "referral",
      email: "info@acme.example.com",
    },
    { displayName: "Brightwater Roofing", type: "company", status: "lead", source: "website" },
    {
      displayName: "Ada Quill",
      companyName: "Quillmere Plumbing",
      email: "ada@acme-mail.example.com",
      status: "inactive",
    },
    { displayName: "100% Pure Water", status: "lead" },
  ])
    expect((await post(owner, body)).status).toBe(201);
  expect(
    (
      await post(
        other,
        { displayName: "Globex Secret Customer", email: "boss@globex.example.com" },
        orgB,
      )
    ).status,
  ).toBe(201);
  psql(`insert into public.customers (organization_id, display_name, created_by)
        select '${orgA}', 'Bulk ' || lpad(i::text, 2, '0'), null from generate_series(1, 30) i`);
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/customers", () => {
  it("returns the standard envelope with meta.page, limit, total and totalPages (default limit 25)", async () => {
    const res = await get(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.meta).toMatchObject({ page: 1, limit: 25, total: 34, totalPages: 2 });
    expect(body.data).toHaveLength(25);
    expect(body.data[0]).toMatchObject({
      id: expect.any(String),
      displayName: expect.any(String),
      status: expect.any(String),
      tags: expect.any(Array),
    });
    expect(body.data[0]).not.toHaveProperty("organizationId");
    expect(body.data[0]).not.toHaveProperty("search_text");
    expect(body.data[0]).not.toHaveProperty("searchText");
  });

  it("paginates without repeating or skipping rows, and a page past the end is empty with the real total", async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3, 4]) {
      const body = await (
        await get(owner, `?limit=10&page=${page}&sort=display_name&order=asc`)
      ).json();
      expect(body.meta).toMatchObject({ page, limit: 10, total: 34, totalPages: 4 });
      seen.push(...body.data.map((c: { id: string }) => c.id));
    }
    expect(seen).toHaveLength(34);
    expect(new Set(seen).size).toBe(34);
    const past = await (await get(owner, "?limit=10&page=99")).json();
    expect(past.data).toEqual([]);
    expect(past.meta).toMatchObject({ page: 99, total: 34, totalPages: 4 });
  });

  it("sorts by a whitelisted column in either direction", async () => {
    const asc = await names(await get(owner, "?sort=display_name&order=asc&limit=5"));
    expect(asc).toEqual(
      [...asc].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })).slice(0, 5),
    );
    expect(asc[0]).toBe("100% Pure Water");
    expect(await names(await get(owner, "?sort=display_name&order=desc&limit=1"))).toEqual([
      "Bulk 30",
    ]);
    const created = await names(await get(owner, "?sort=created_at&order=asc&limit=1"));
    expect(created).toEqual(["Acme Plumbing"]);
  });

  it("filters by status and source", async () => {
    expect((await names(await get(owner, "?status=inactive"))).sort()).toEqual(["Ada Quill"]);
    expect(await names(await get(owner, "?source=referral"))).toEqual(["Acme Plumbing"]);
    expect(await names(await get(owner, "?status=lead&source=website"))).toEqual([
      "Brightwater Roofing",
    ]);
  });

  it("searches partial name, company and e-mail, case-insensitively", async () => {
    expect((await names(await get(owner, "?q=acm"))).sort()).toEqual([
      "Acme Plumbing",
      "Ada Quill",
    ]); // name and e-mail
    expect(await names(await get(owner, "?q=QUILLM"))).toEqual(["Ada Quill"]); // company
    expect(await names(await get(owner, "?q=brightw"))).toEqual(["Brightwater Roofing"]);
    expect(await names(await get(owner, "?q=ada@acme-mail"))).toEqual(["Ada Quill"]);
    expect(await names(await get(owner, "?q=zzzz-no-match"))).toEqual([]);
    const body = await (await get(owner, "?q=plumbing")).json();
    expect(body.meta.total).toBe(2);
  });

  it("treats search text literally: wildcards, quotes, commas, parentheses and SQL are just text", async () => {
    expect(await names(await get(owner, `?q=${encodeURIComponent("%")}`))).toEqual([
      "100% Pure Water",
    ]);
    expect(await names(await get(owner, `?q=${encodeURIComponent("_")}`))).toEqual([]);
    for (const evil of [
      "'; drop table customers; --",
      "a,b)(c",
      'x" or "1"="1',
      "\\",
      "%%",
      "a.eq.b",
      "ada) or (display_name.ilike.%",
    ]) {
      const res = await get(owner, `?q=${encodeURIComponent(evil)}`);
      expect(res.status, evil).toBe(200);
      expect((await res.json()).data, evil).toEqual([]);
    }
    expect(
      Number(psql(`select count(*) from public.customers where organization_id = '${orgA}'`)),
    ).toBe(34);
  });

  it("hides archived customers unless asked", async () => {
    psql(
      `update public.customers set archived_at = now() where organization_id = '${orgA}' and display_name = 'Brightwater Roofing'`,
    );
    expect(await names(await get(owner, "?q=brightw"))).toEqual([]);
    expect(await names(await get(owner, "?q=brightw&archived=true"))).toEqual([
      "Brightwater Roofing",
    ]);
    expect(await names(await get(owner, "?q=brightw&archived=all"))).toEqual([
      "Brightwater Roofing",
    ]);
    expect((await (await get(owner, "?archived=false")).json()).meta.total).toBe(33);
    psql(`update public.customers set archived_at = null where organization_id = '${orgA}'`);
  });

  it("422 for invalid parameters, with field errors", async () => {
    for (const qs of [
      "?limit=101",
      "?limit=0",
      "?page=0",
      "?sort=password",
      "?order=up",
      "?status=won",
      "?archived=maybe",
      "?bogus=1",
      "?limit=5&limit=6",
    ]) {
      const res = await get(owner, qs);
      expect(res.status, qs).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.fieldErrors).toBeTruthy();
    }
  });

  it("every role that can read the workspace can list it", async () => {
    for (const actor of [owner, admin, member, viewer]) expect((await get(actor)).status).toBe(200);
  });

  it("401 signed out; a user with no membership gets 404 for that workspace; a foreign workspace id is 404", async () => {
    expect((await get(null)).status).toBe(401);
    expect((await get(outsider)).status).toBe(404);
    expect((await get(owner, "", orgB)).status).toBe(404);
    expect((await get(other, "", orgA)).status).toBe(404);
  });

  it("cross-tenant records never appear, by listing or by searching for them", async () => {
    const all = await names(await get(owner, "?limit=100"));
    expect(all).not.toContain("Globex Secret Customer");
    expect(await names(await get(owner, "?q=globex"))).toEqual([]);
    expect(await names(await get(owner, "?q=boss@globex"))).toEqual([]);
    expect(await names(await get(other, "?q=globex", orgB))).toEqual(["Globex Secret Customer"]);
    expect(await names(await get(other, "?q=acme", orgB))).toEqual([]);
  });

  it("a guest lists only their own seeded demo (18 customers, 3 archived)", async () => {
    const res = await get(guest, "?archived=all&limit=100", demoOrg);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.meta.total).toBe(18);
    expect(
      body.data.filter((c: { archivedAt: string | null }) => c.archivedAt !== null),
    ).toHaveLength(3);
    expect((await get(guest, "", orgA)).status).toBe(404);
  });
});

describe("POST /api/v1/customers", () => {
  it("201: creates and returns the record, normalized, and logs a created event", async () => {
    const res = await post(member, {
      displayName: "  Warehouse Retrofit Co ",
      email: "  Info@WRC.Example.com ",
      tags: ["VIP", "vip"],
      status: "active",
      notes: "secret boiler note",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({
      displayName: "Warehouse Retrofit Co",
      email: "info@wrc.example.com",
      tags: ["VIP"],
      status: "active",
      type: "person",
      source: "other",
      createdBy: member.id,
      archivedAt: null,
    });
    expect(body.meta).toEqual({});
    const event = psql(
      `select action || '|' || actor_user_id || '|' || summary from public.activity_events where entity_id = '${body.data.id}'`,
    );
    expect(event).toMatch(
      new RegExp(`^created\\|${member.id}\\|.* created customer "Warehouse Retrofit Co"$`),
    );
    expect(
      psql(
        `select count(*) from public.activity_events where changes::text like '%boiler%' or summary like '%boiler%'`,
      ),
    ).toBe("0");
    const listed = await names(await get(owner, "?q=warehouse"));
    expect(listed).toEqual(["Warehouse Retrofit Co"]);
  });

  it("owner, admin and member can create; the creator is always the caller, whatever the body says", async () => {
    for (const actor of [owner, admin, member]) {
      const res = await post(actor, { displayName: `By ${actor.email!.slice(0, 8)}` });
      expect(res.status).toBe(201);
      expect((await res.json()).data.createdBy).toBe(actor.id);
    }
    for (const extra of [
      { createdBy: owner.id },
      { created_by: owner.id },
      { organizationId: orgB },
      { organization_id: orgB },
      { id: crypto.randomUUID() },
    ]) {
      const res = await post(member, { displayName: "Injected", ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(
      Number(psql(`select count(*) from public.customers where display_name = 'Injected'`)),
    ).toBe(0);
  });

  it("403: a viewer cannot create, and nothing is saved", async () => {
    const res = await post(viewer, { displayName: "Viewer Made" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(
      Number(psql(`select count(*) from public.customers where display_name = 'Viewer Made'`)),
    ).toBe(0);
  });

  it("401 signed out; 404 for a workspace the caller is not in (including writing into another tenant)", async () => {
    expect((await post(null, { displayName: "Nobody" })).status).toBe(401);
    expect((await post(outsider, { displayName: "Outsider" })).status).toBe(404);
    expect((await post(owner, { displayName: "Into B" }, orgB)).status).toBe(404);
    expect(
      Number(
        psql(
          `select count(*) from public.customers where display_name in ('Nobody', 'Outsider', 'Into B')`,
        ),
      ),
    ).toBe(0);
  });

  it("422 with field errors for invalid input", async () => {
    const cases: Array<[unknown, string]> = [
      [{ displayName: "x" }, "displayName"],
      [{}, "displayName"],
      [{ displayName: "Ok", email: "nope" }, "email"],
      [{ displayName: "Ok", website: "javascript:alert(1)" }, "website"],
      [{ displayName: "Ok", status: "won" }, "status"],
      [{ displayName: "Ok", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "tags"],
      [{ displayName: "Ok", tags: ["t".repeat(31)] }, "tags.0"],
      [{ displayName: "Ok", notes: "n".repeat(5001) }, "notes"],
      [{ displayName: "<b>bold</b>" }, "displayName"],
    ];
    for (const [body, field] of cases) {
      const res = await post(owner, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe("VALIDATION_ERROR");
      expect(Object.keys(json.error.fieldErrors)).toContain(field);
    }
    const bad = await server.request(PATH, owner, {
      method: "POST",
      headers: { ...hdr(orgA), "content-type": "application/json" },
      json: undefined,
    });
    expect([400, 415, 422]).toContain(bad.status);
  });

  it("422 when the assignee is not a member of this workspace; fine when they are", async () => {
    const foreign = await post(owner, { displayName: "Bad Assignee", assignedTo: other.id });
    expect(foreign.status).toBe(422);
    expect((await foreign.json()).error.code).toBe("INVALID_REFERENCE");
    const own = await post(owner, { displayName: "Good Assignee", assignedTo: member.id });
    expect(own.status).toBe(201);
    expect((await own.json()).data.assignedTo).toBe(member.id);
    expect(
      Number(psql(`select count(*) from public.customers where display_name = 'Bad Assignee'`)),
    ).toBe(0);
  });

  it("a duplicate e-mail returns the record with a warning, not an error (case-insensitive, archived included)", async () => {
    const first = await post(owner, { displayName: "Dup One", email: "shared@family.example.com" });
    expect(first.status).toBe(201);
    expect((await first.json()).meta).toEqual({});
    const firstId = psql(`select id from public.customers where display_name = 'Dup One'`);
    const second = await post(owner, {
      displayName: "Dup Two",
      email: "  SHARED@Family.Example.com ",
    });
    expect(second.status).toBe(201);
    const body = await second.json();
    expect(body.data.displayName).toBe("Dup Two");
    expect(body.meta.warnings).toEqual([
      {
        code: "DUPLICATE_EMAIL",
        field: "email",
        message: expect.stringContaining("Dup One"),
        customerId: firstId,
      },
    ]);
    psql(`update public.customers set archived_at = now() where id = '${firstId}'`);
    const third = await post(owner, {
      displayName: "Dup Three",
      email: "shared@family.example.com",
    });
    expect(third.status).toBe(201);
    expect((await third.json()).meta.warnings).toHaveLength(1);
    expect(
      Number(
        psql(`select count(*) from public.customers where email = 'shared@family.example.com'`),
      ),
    ).toBe(3);
  });

  it("a duplicate in ANOTHER workspace is not a duplicate", async () => {
    const res = await post(
      other,
      { displayName: "Elsewhere", email: "shared@family.example.com" },
      orgB,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).meta).toEqual({});
  });

  it("429: the demo cap is reported in the envelope", async () => {
    const have = Number(
      psql(`select count(*) from public.customers where organization_id = '${demoOrg}'`),
    );
    psql(
      `insert into public.customers (organization_id, display_name, created_by) select '${demoOrg}', 'Filler ' || i, null from generate_series(1, ${50 - have}) i`,
    );
    const res = await post(guest, { displayName: "One Too Many" }, demoOrg);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe("DEMO_CAP");
    expect(body.error.message).toMatch(/limit/i);
    expect(
      Number(psql(`select count(*) from public.customers where organization_id = '${demoOrg}'`)),
    ).toBe(50);
  });

  it("a guest can create in their own demo (below the cap) and cannot reach a real workspace", async () => {
    psql(
      `delete from public.customers where organization_id = '${demoOrg}' and display_name like 'Filler %'`,
    );
    expect((await post(guest, { displayName: "Guest Made" }, demoOrg)).status).toBe(201);
    expect((await post(guest, { displayName: "Guest Into A" }, orgA)).status).toBe(404);
  });

  it("a foreign Origin is refused before anything else", async () => {
    const res = await server.request(PATH, owner, {
      json: { displayName: "Evil" },
      headers: { ...hdr(orgA), origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(Number(psql(`select count(*) from public.customers where display_name = 'Evil'`))).toBe(
      0,
    );
  });
});
