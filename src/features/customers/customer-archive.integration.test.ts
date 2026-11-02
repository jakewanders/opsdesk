import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-234] Archive / restore over real HTTP: round trip, activity events, open-record counts, and what stays visible. */
const server = new RealServer();
let owner: Actor, viewer: Actor;
let org = "";
const hdr = { "X-Organization-Id": "" };
const api = (actor: Actor, method: string, path: string, json?: unknown) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: hdr });
const page = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");

beforeAll(async () => {
  await server.start();
  [owner, viewer] = await Promise.all([server.member("ar-owner"), server.member("ar-viewer")]);
  const res = await server.request("/api/v1/organizations", owner, {
    json: { name: "Archive Co" },
  });
  org = (await res.json()).data.id;
  hdr["X-Organization-Id"] = org;
}, 400_000);
afterAll(() => server.stop());

const mkCustomer = async (name: string) =>
  (await (await api(owner, "POST", "/customers", { displayName: name })).json()).data.id as string;

describe("archive and restore [SIT-234]", () => {
  it("related counts split total from open: won/lost deals and done tasks are not open", async () => {
    const id = await mkCustomer("Counts Co");
    const deal = async (title: string, stage?: string) =>
      (
        await (
          await api(owner, "POST", "/opportunities", {
            customerId: id,
            title,
            amountCents: 100,
            stage,
          })
        ).json()
      ).data.id;
    await deal("Open one");
    await deal("Open two", "proposal");
    const won = (
      await (
        await api(owner, "POST", "/opportunities", {
          customerId: id,
          title: "Won one",
          amountCents: 100,
        })
      ).json()
    ).data;
    const moved = await api(owner, "POST", `/opportunities/${won.id}/stage`, {
      stage: "won",
      expectedUpdatedAt: won.updatedAt,
    });
    expect(moved.status).toBe(200);
    const t1 = (
      await (await api(owner, "POST", "/tasks", { customerId: id, title: "Open task" })).json()
    ).data;
    const t2 = (
      await (await api(owner, "POST", "/tasks", { customerId: id, title: "Done task" })).json()
    ).data;
    expect(
      (
        await api(owner, "POST", `/tasks/${t2.id}/complete`, {
          completed: true,
          expectedUpdatedAt: t2.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect(t1.id).toBeTruthy();
    const related = (await (await api(owner, "GET", `/customers/${id}`)).json()).data.related;
    expect(related).toMatchObject({
      opportunities: 3,
      openOpportunities: 2,
      tasks: 2,
      openTasks: 1,
    });
  });

  it("archive then restore round-trips, hides and shows the customer in the default list, and each writes an event shown on the detail page", async () => {
    const id = await mkCustomer("Roundtrip Co");
    const inList = async (archived?: string) =>
      (
        (
          await (
            await api(
              owner,
              "GET",
              `/customers?q=Roundtrip${archived ? `&archived=${archived}` : ""}`,
            )
          ).json()
        ).data as { id: string }[]
      ).map((c) => c.id);
    expect(await inList()).toContain(id);
    expect((await api(owner, "DELETE", `/customers/${id}`)).status).toBe(204);
    expect(await inList()).not.toContain(id);
    expect(await inList("true")).toContain(id);
    expect(await page(`/app/customers/${id}`, owner)).toContain("This customer is archived.");
    expect((await api(owner, "POST", `/customers/${id}/restore`)).status).toBe(200);
    expect(await inList()).toContain(id);
    expect(await inList("true")).not.toContain(id);
    const html = await page(`/app/customers/${id}`, owner);
    expect(html).not.toContain("This customer is archived.");
    for (const action of ["archived", "restored"])
      expect(html).toContain(`\\"action\\":\\"${action}\\"`);
  });

  it("an archived customer's opportunities and tasks stay listed and still link to the customer", async () => {
    const id = await mkCustomer("Keeps Deals Co");
    const deal = (
      await (
        await api(owner, "POST", "/opportunities", {
          customerId: id,
          title: "Survivor Deal",
          amountCents: 5000,
        })
      ).json()
    ).data.id;
    expect((await api(owner, "DELETE", `/customers/${id}`)).status).toBe(204);
    const list = (await (await api(owner, "GET", "/opportunities?q=Survivor")).json()).data;
    expect(list.map((o: { id: string }) => o.id)).toContain(deal);
    expect(list.find((o: { id: string }) => o.id === deal).customerId).toBe(id);
    const detail = await page(`/app/opportunities/${deal}`, owner);
    expect(detail).toContain("Survivor Deal");
    expect(detail).toContain(`/app/customers/${id}`);
  });

  it("a viewer is refused on both endpoints and the customer is unchanged", async () => {
    const id = await mkCustomer("Viewer Target");
    const { psql } = await import("@/test/local-supabase");
    psql(
      `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
    );
    for (const [m, p] of [
      ["DELETE", `/customers/${id}`],
      ["POST", `/customers/${id}/restore`],
    ]) {
      const res = await api(viewer, m, p);
      expect(res.status, p).toBe(403);
    }
    const c = (await (await api(owner, "GET", `/customers/${id}`)).json()).data;
    expect(c.archivedAt).toBeNull();
    const html = await page(`/app/customers/${id}`, viewer);
    expect(html).toContain("You can view this customer but not archive it");
  });
});
