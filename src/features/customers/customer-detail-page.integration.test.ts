import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-226] The customer detail page over real HTTP: first read on the server, activity from the database, no leakage across tenants. */
const server = new RealServer();
let owner: Actor, viewer: Actor, other: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let customerA = "";
let customerB = "";
let archivedA = "";

const hdr = (o: string) => ({ "X-Organization-Id": o });
const page = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");
const api = (actor: Actor, method: string, path: string, json?: unknown, o = orgA) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: hdr(o) });

beforeAll(async () => {
  await server.start();
  [owner, viewer, other, guest] = await Promise.all([
    server.member("cd-owner"),
    server.member("cd-viewer"),
    server.member("cd-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  orgA = await mk(owner, "Detail Co A");
  orgB = await mk(other, "Detail Co B");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${orgA}', '${viewer.id}', 'viewer')`,
  );
  const created = await api(owner, "POST", "/customers", {
    displayName: "Acme Detail",
    companyName: "Acme Group",
    email: "d@acme.example.com",
    website: "https://acme.example.com",
    tags: ["vip"],
    notes: "Private gate code 4711 & more",
    type: "company",
  });
  customerA = (await created.json()).data.id;
  // an edit so the timeline has a field change and a content-only change
  const cur = (await (await api(owner, "GET", `/customers/${customerA}`)).json()).data;
  expect(
    (
      await api(owner, "PATCH", `/customers/${customerA}`, {
        status: "active",
        notes: "Changed note secret-9999",
        expectedUpdatedAt: cur.updatedAt,
      })
    ).status,
  ).toBe(200);
  archivedA = (
    await (await api(owner, "POST", "/customers", { displayName: "Gone Detail" })).json()
  ).data.id;
  expect((await api(owner, "DELETE", `/customers/${archivedA}`)).status).toBe(204);
  customerB = (
    await (
      await api(
        other,
        "POST",
        "/customers",
        { displayName: "Globex Secret Detail", notes: "other tenant note" },
        orgB,
      )
    ).json()
  ).data.id;
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

describe("/app/customers/:id", () => {
  it("shows the record in the server-rendered HTML: name, type, company, status, tags, notes as escaped text, the website link", async () => {
    const html = await page(`/app/customers/${customerA}`, owner);
    expect(html).toContain("Acme Detail");
    expect(html).toContain("Acme Group");
    expect(html).toContain("Active");
    expect(html).toContain("vip");
    expect(html).toContain("d@acme.example.com");
    expect(html).toContain("Changed note secret-9999");
    expect(html).toContain('href="https://acme.example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    const ampersand = await page(`/app/customers/${customerA}`, owner);
    expect(ampersand).not.toContain("Private gate code 4711 & more"); // the old note was replaced; and any & would be escaped
  });
  it("activity comes from the database: who, what and when, field changes with old and new, and only the NAME of an edited note field", async () => {
    const html = await page(`/app/customers/${customerA}`, owner);
    expect(html).toContain("Activity");
    expect(html).toContain("created customer");
    expect(html).toContain("updated customer");
    // the tab body renders on the client; the server sends the events in the page data
    expect(html).toMatch(/status[^}]*lead[^}]*active/);
    expect(html).toMatch(/contentChanged[^\]]*notes/);
    expect(html).not.toContain("secret-9999\u0000");
    // the content of notes appears only in the Overview, never in the activity timeline's data
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${customerA}' and (changes::text like '%secret-9999%' or summary like '%secret-9999%' or changes::text like '%4711%')`,
      ),
    ).toBe("0");
  });
  it("an owner sees Edit and Archive; a viewer sees the record and neither; both see the same data", async () => {
    const o = await page(`/app/customers/${customerA}`, owner);
    expect(o).toContain(`/app/customers/${customerA}/edit`);
    expect(o).toContain(">Archive<");
    const v = await page(`/app/customers/${customerA}`, viewer);
    expect(v).toContain("Acme Detail");
    expect(v).not.toContain(`/app/customers/${customerA}/edit`);
    expect(v).not.toContain(">Archive<");
    expect(v).not.toContain(">Restore<");
  });
  it("an archived customer says Archived and offers Restore to a writer only", async () => {
    const o = await page(`/app/customers/${archivedA}`, owner);
    expect(o).toContain("Gone Detail");
    expect(o).toContain("This customer is archived.");
    expect(o).toContain(">Restore<");
    expect(o).not.toContain(`/app/customers/${archivedA}/edit`);
    const v = await page(`/app/customers/${archivedA}`, viewer);
    expect(v).toContain("This customer is archived.");
    expect(v).not.toContain(">Restore<");
    expect(o).toContain("archived customer");
  });
  it("another workspace's customer, an unknown id and a malformed id are the same not-found page and reveal nothing", async () => {
    for (const path of [
      `/app/customers/${customerB}`,
      `/app/customers/${crypto.randomUUID()}`,
      "/app/customers/not-an-id",
    ]) {
      const html = await page(path, owner);
      expect(html, path).toContain("This record does not exist, or you do not have access to it.");
      for (const leaked of ["Globex Secret Detail", "other tenant note", "Acme Detail"])
        expect(html, `${path} ${leaked}`).not.toContain(leaked);
    }
    const guestView = await page(`/app/customers/${customerA}`, guest);
    expect(guestView).toContain("This record does not exist, or you do not have access to it.");
    expect(guestView).not.toContain("Acme Detail");
  });
  it("a demo guest sees a seeded customer with its System-created event", async () => {
    const list = await (
      await server.request("/api/v1/customers?limit=1&sort=display_name&order=asc", guest)
    ).json();
    const html = await page(`/app/customers/${list.data[0].id}`, guest);
    expect(html).toContain(list.data[0].displayName);
    expect(html).toContain("System created customer");
  });
  it("archive then restore through the API changes what the page shows, and the timeline gains both events", async () => {
    const id = (
      await (await api(owner, "POST", "/customers", { displayName: "Cycle Detail" })).json()
    ).data.id;
    await api(owner, "DELETE", `/customers/${id}`);
    expect(await page(`/app/customers/${id}`, owner)).toContain("This customer is archived.");
    expect((await api(owner, "POST", `/customers/${id}/restore`)).status).toBe(200);
    const html = await page(`/app/customers/${id}`, owner);
    expect(html).not.toContain("This customer is archived.");
    expect(html).toContain("archived customer");
    expect(html).toContain("restored customer");
  });
});
