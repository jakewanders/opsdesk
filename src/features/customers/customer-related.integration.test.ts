import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-243] The lists behind the customer page's Opportunities and Tasks tabs, over real HTTP. */
const server = new RealServer();
let a: Actor, b: Actor;
let orgA = "";
let orgB = "";
let acme = "";
let globex = "";
let foreign = "";
const api = (actor: Actor, method: string, path: string, json?: unknown, org = orgA) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: { "X-Organization-Id": org } });
const ids = async (actor: Actor, path: string, org = orgA) =>
  ((await (await api(actor, "GET", path, undefined, org)).json()).data as { id: string }[]).map(
    (x) => x.id,
  );

beforeAll(async () => {
  await server.start();
  [a, b] = await Promise.all([server.member("rel-a"), server.member("rel-b")]);
  const mk = async (actor: Actor, name: string) =>
    (await (await server.request("/api/v1/organizations", actor, { json: { name } })).json()).data
      .id as string;
  orgA = await mk(a, "Related Co A");
  orgB = await mk(b, "Related Co B");
  const cust = async (actor: Actor, name: string, org: string) =>
    (await (await api(actor, "POST", "/customers", { displayName: name }, org)).json()).data
      .id as string;
  acme = await cust(a, "Acme Related", orgA);
  globex = await cust(a, "Globex Related", orgA);
  foreign = await cust(b, "Foreign Related", orgB);
}, 400_000);
afterAll(() => server.stop());

describe("related lists [SIT-243]", () => {
  it("opportunities and tasks filtered by customerId return only that customer's records; the counts on the detail match", async () => {
    const opp = async (customerId: string, title: string) =>
      (
        await (
          await api(a, "POST", "/opportunities", { customerId, title, amountCents: 100 })
        ).json()
      ).data.id as string;
    const task = async (customerId: string, title: string) =>
      (await (await api(a, "POST", "/tasks", { customerId, title })).json()).data.id as string;
    const [o1, o2, og] = [
      await opp(acme, "Acme one"),
      await opp(acme, "Acme two"),
      await opp(globex, "Globex one"),
    ];
    const [t1, tg] = [await task(acme, "Acme task"), await task(globex, "Globex task")];
    expect(await ids(a, `/opportunities?customerId=${acme}`)).toEqual(
      expect.arrayContaining([o1, o2]),
    );
    expect(await ids(a, `/opportunities?customerId=${acme}`)).not.toContain(og);
    expect(await ids(a, `/tasks?customerId=${acme}`)).toEqual([t1]);
    expect(await ids(a, `/tasks?customerId=${globex}`)).toEqual([tg]);
    const related = (await (await api(a, "GET", `/customers/${acme}`)).json()).data.related;
    expect(related).toMatchObject({ opportunities: 2, tasks: 1 });
  });

  it("another workspace's customer id returns nothing (and leaks nothing), from either side", async () => {
    await api(
      b,
      "POST",
      "/opportunities",
      { customerId: foreign, title: "Foreign deal", amountCents: 1 },
      orgB,
    );
    await api(b, "POST", "/tasks", { customerId: foreign, title: "Foreign task" }, orgB);
    expect(await ids(a, `/opportunities?customerId=${foreign}`)).toEqual([]);
    expect(await ids(a, `/tasks?customerId=${foreign}`)).toEqual([]);
    expect(await ids(b, `/opportunities?customerId=${acme}`, orgB)).toEqual([]);
  });

  it("archiving the customer keeps its history in both lists, and paging is server-side", async () => {
    const c = (await (await api(a, "POST", "/customers", { displayName: "Paged Related" })).json())
      .data.id as string;
    for (let i = 0; i < 12; i++)
      await api(a, "POST", "/opportunities", {
        customerId: c,
        title: `Paged ${i}`,
        amountCents: 1,
      });
    expect((await api(a, "DELETE", `/customers/${c}`)).status).toBe(204);
    const first = await (
      await api(a, "GET", `/opportunities?customerId=${c}&limit=10&page=1`)
    ).json();
    const second = await (
      await api(a, "GET", `/opportunities?customerId=${c}&limit=10&page=2`)
    ).json();
    expect(first.data).toHaveLength(10);
    expect(second.data).toHaveLength(2);
    expect(first.meta).toMatchObject({ total: 12, totalPages: 2 });
  });

  it("the prefilled create pages start on the customer and ignore a foreign one", async () => {
    const html = async (path: string) =>
      (await (await server.request(path, a)).text()).replace(/<!-- -->/g, "");
    expect(await html(`/app/opportunities/new?customerId=${acme}`)).toContain(
      'value="Acme Related"',
    );
    const bad = await html(`/app/opportunities/new?customerId=${foreign}`);
    expect(bad).not.toContain("Foreign Related");
  });
});
