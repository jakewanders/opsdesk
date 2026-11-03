import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * The contract of the four list endpoints (SIT-250, PRD F15, 7.3), over real HTTP: every filter and every sort option of customers,
 * opportunities, tasks and quotes returns exactly the rows it should on a small known fixture; paging metadata is the same shape
 * everywhere; invalid values are 422 with field errors; and injection-style text is rejected or harmless.
 */
const server = new RealServer();
let owner: Actor, member: Actor;
let org = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hdr = { "X-Organization-Id": "" };
const get = (actor: Actor, path: string) =>
  server.request(`/api/v1${path}`, actor, { headers: { "X-Organization-Id": org } });
const post = async (actor: Actor, path: string, json: unknown): Promise<any> => {
  const res = await server.request(`/api/v1${path}`, actor, {
    method: "POST",
    json,
    headers: { "X-Organization-Id": org },
  });
  expect(res.status, `${path} ${JSON.stringify(json)}`).toBeLessThan(300);
  return (await res.json()).data;
};
/** The titles / names a list returns, in order. */
const names = async (path: string, key: string, actor = owner): Promise<string[]> => {
  const res = await get(actor, path);
  expect(res.status, path).toBe(200);
  return ((await res.json()).data as any[]).map((r) => r[key]);
};
const sorted = (xs: string[]) => [...xs].sort();
const refused = async (base: string, qs: string) => {
  const path = `${base}?${qs}`;
  const res = await get(owner, path);
  expect(res.status, path).toBe(422);
  const body = (await res.json()).error;
  expect(body.code).toBe("VALIDATION_ERROR");
  // an error inside a list is keyed "tags.0": report it under the parameter's own name
  const out: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(body.fieldErrors as Record<string, string[]>)) {
    (out[key.split(".")[0]] ??= []).push(...messages);
  }
  return out;
};
const q = encodeURIComponent;

const ids: Record<string, string> = {};

beforeAll(async () => {
  await server.start();
  [owner, member] = await Promise.all([server.member("lc-owner"), server.member("lc-member")]);
  const created = await server.request("/api/v1/organizations", owner, {
    json: { name: "List Contract Co", timezone: "America/New_York" },
  });
  org = (await created.json()).data.id;
  hdr["X-Organization-Id"] = org;
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${member.id}', 'member')`,
  );

  // ---- customers
  const c = async (displayName: string, extra: Record<string, unknown> = {}) =>
    (await post(owner, "/customers", { displayName, ...extra })).id as string;
  ids.alpha = await c("Alpha Co", {
    status: "lead",
    source: "referral",
    tags: ["vip", "north"],
    assignedTo: owner.id,
  });
  ids.bravo = await c("Bravo Co", { status: "active", source: "website", tags: ["vip"] });
  ids.charlie = await c("Charlie Co", { status: "inactive", source: "outbound" });
  ids.delta = await c("Delta Co", {
    status: "lead",
    source: "other",
    tags: ["north", "south", "east"],
  });
  ids.echo = await c("Echo Co", { status: "active", source: "referral" });
  ids.foxtrot = await c("Foxtrot Co", { status: "lead", source: "other" });
  await server.request(`/api/v1/customers/${ids.echo}`, owner, {
    method: "DELETE",
    headers: { "X-Organization-Id": org },
  }); // archived
  // known times (the workspace is in New York): the start of Mar 8 is 05:00Z, the start of Mar 9 is 04:00Z (clocks changed at 02:00 Mar 8)
  psql(`alter table public.customers disable trigger user`);
  const at = (id: string, created: string, updated: string) =>
    psql(
      `update public.customers set created_at = '${created}', updated_at = '${updated}' where id = '${id}'`,
    );
  at(ids.alpha, "2026-03-08T04:30:00Z", "2026-04-10T12:00:00Z"); // Mar 7 23:30 local
  at(ids.bravo, "2026-03-08T06:00:00Z", "2026-04-11T12:00:00Z"); // Mar 8 01:00 local
  at(ids.charlie, "2026-03-09T03:59:00Z", "2026-04-12T12:00:00Z"); // Mar 8 23:59 local
  at(ids.delta, "2026-03-09T04:00:00Z", "2026-04-13T12:00:00Z"); // Mar 9 00:00 local
  at(ids.foxtrot, "2026-03-10T12:00:00Z", "2026-04-14T12:00:00Z");
  psql(`alter table public.customers enable trigger user`);

  // ---- opportunities
  const o = async (title: string, customerId: string, extra: Record<string, unknown> = {}) =>
    (await post(owner, "/opportunities", { title, customerId, ...extra })).id as string;
  ids.o1 = await o("Deal one", ids.alpha, {
    stage: "new",
    amountCents: 100000,
    expectedCloseDate: "2026-12-01",
    assignedTo: owner.id,
  });
  ids.o2 = await o("Deal two", ids.alpha, {
    stage: "qualified",
    amountCents: 250000,
    expectedCloseDate: "2026-12-15",
  });
  ids.o3 = await o("Deal three", ids.bravo, {
    stage: "proposal",
    amountCents: 250000,
    expectedCloseDate: "2027-01-10",
  });
  ids.o4 = await o("Deal four", ids.bravo, {
    stage: "negotiation",
    amountCents: 900000,
    expectedCloseDate: "2027-02-01",
    assignedTo: owner.id,
  });
  ids.o5 = await o("Deal five", ids.charlie, { stage: "new", amountCents: 0 });
  // ---- tasks
  const t = async (title: string, extra: Record<string, unknown> = {}) =>
    (await post(owner, "/tasks", { title, ...extra })).id as string;
  ids.t1 = await t("Task one", {
    dueDate: "2026-01-10",
    priority: "low",
    assignedTo: owner.id,
    customerId: ids.alpha,
  });
  ids.t2 = await t("Task two", {
    dueDate: "2026-06-15",
    priority: "urgent",
    status: "in_progress",
    customerId: ids.bravo,
    opportunityId: ids.o3,
  });
  ids.t3 = await t("Task three", {
    dueDate: "2026-06-20",
    priority: "high",
    status: "blocked",
    assignedTo: member.id,
  });
  ids.t4 = await t("Task four", { priority: "medium", status: "done", assignedTo: owner.id });
  ids.t5 = await t("Task five", {
    dueDate: "2099-01-01",
    priority: "medium",
    opportunityId: ids.o1,
  });
  // ---- quotes
  const qt = async (
    title: string,
    issueDate: string,
    validUntil: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    (
      await post(owner, "/quotes", {
        title,
        customerId: extra.customerId ?? ids.alpha,
        issueDate,
        validUntil,
        items: [{ description: "Line", quantity: 1, unitPriceCents: Number(extra.price ?? 10000) }],
        ...Object.fromEntries(
          Object.entries(extra).filter(([k]) => !["price", "customerId"].includes(k)),
        ),
      })
    ).id as string;
  ids.q1 = await qt("Quote one", "2026-10-01", "2026-10-31", { price: 10000 });
  ids.q2 = await qt("Quote two", "2026-10-10", "2026-11-10", {
    price: 30000,
    customerId: ids.bravo,
  });
  ids.q3 = await qt("Quote three", "2026-10-20", null, { price: 20000, customerId: ids.bravo });
  ids.q4 = await qt("Quote four", "2026-11-01", "2026-12-01", {
    price: 5000,
    opportunityId: ids.o3,
    customerId: ids.bravo,
  });
  await post(owner, `/quotes/${ids.q2}/transition`, { to: "sent" });
  await post(owner, `/quotes/${ids.q3}/transition`, { to: "sent" });
  await post(owner, `/quotes/${ids.q3}/transition`, { to: "approved" });
}, 400_000);

afterAll(() => server.stop());

describe("customers", () => {
  const list = (qs: string) => names(`/customers?${qs}&limit=100`, "displayName");
  it("filters: status, source, owner, tags (all of them), created range, updated range, archived, search", async () => {
    const all = ["Alpha Co", "Bravo Co", "Charlie Co", "Delta Co", "Foxtrot Co"];
    expect(sorted(await list(""))).toEqual(all);
    expect(sorted(await list("status=lead"))).toEqual(["Alpha Co", "Delta Co", "Foxtrot Co"]);
    expect(sorted(await list("source=referral"))).toEqual(["Alpha Co"]);
    expect(sorted(await list(`assignedTo=${owner.id}`))).toEqual(["Alpha Co"]);
    expect(sorted(await list("tags=vip"))).toEqual(["Alpha Co", "Bravo Co"]);
    expect(sorted(await list("tags=vip,north"))).toEqual(["Alpha Co"]);
    expect(sorted(await list("tags=north,south,east"))).toEqual(["Delta Co"]);
    expect(await list("tags=vip,south")).toEqual([]);
    expect(sorted(await list("tags=vip%2C%20north"))).toEqual(["Alpha Co"]); // spaces after commas are trimmed
    // created range, in the workspace's time zone (New York): Mar 8 local is 05:00Z to 04:00Z the next day, a 23-hour day
    expect(sorted(await list("createdFrom=2026-03-08&createdTo=2026-03-08"))).toEqual([
      "Bravo Co",
      "Charlie Co",
    ]);
    expect(sorted(await list("createdFrom=2026-03-09"))).toEqual(["Delta Co", "Foxtrot Co"]);
    expect(sorted(await list("createdTo=2026-03-07"))).toEqual(["Alpha Co"]);
    expect(sorted(await list("updatedFrom=2026-04-11&updatedTo=2026-04-12"))).toEqual([
      "Bravo Co",
      "Charlie Co",
    ]);
    expect(sorted(await list("status=lead&tags=north&createdFrom=2026-03-09"))).toEqual([
      "Delta Co",
    ]); // filters combine
    expect(await list("archived=true")).toEqual(["Echo Co"]);
    expect(sorted(await list("archived=all"))).toEqual([...all, "Echo Co"].sort());
    expect(await list("q=charlie")).toEqual(["Charlie Co"]);
  });
  it("sorts by every whitelisted column, both ways, with a stable order", async () => {
    expect(await list("sort=display_name&order=asc")).toEqual([
      "Alpha Co",
      "Bravo Co",
      "Charlie Co",
      "Delta Co",
      "Foxtrot Co",
    ]);
    expect(await list("sort=display_name&order=desc")).toEqual([
      "Foxtrot Co",
      "Delta Co",
      "Charlie Co",
      "Bravo Co",
      "Alpha Co",
    ]);
    expect(await list("sort=created_at&order=asc")).toEqual([
      "Alpha Co",
      "Bravo Co",
      "Charlie Co",
      "Delta Co",
      "Foxtrot Co",
    ]);
    expect(await list("sort=created_at&order=desc")).toEqual([
      "Foxtrot Co",
      "Delta Co",
      "Charlie Co",
      "Bravo Co",
      "Alpha Co",
    ]);
    expect(await list("sort=updated_at&order=asc")).toEqual([
      "Alpha Co",
      "Bravo Co",
      "Charlie Co",
      "Delta Co",
      "Foxtrot Co",
    ]);
    expect(await list("sort=updated_at&order=desc")).toEqual([
      "Foxtrot Co",
      "Delta Co",
      "Charlie Co",
      "Bravo Co",
      "Alpha Co",
    ]);
    const byStatus = await list("sort=status&order=asc");
    expect(byStatus.slice(0, 1)).toEqual(["Bravo Co"]); // active, inactive, lead
    expect(byStatus.slice(1, 2)).toEqual(["Charlie Co"]);
    expect((await list("sort=status&order=desc"))[0]).not.toBe("Bravo Co");
  });
  it("422 with field errors for bad values", async () => {
    expect((await refused("/customers", "createdFrom=2026-13-01")).createdFrom).toBeTruthy();
    expect(
      (await refused("/customers", "createdFrom=2026-03-09&createdTo=2026-03-08")).createdTo,
    ).toBeTruthy();
    expect(
      (await refused("/customers", "updatedFrom=2026-04-12&updatedTo=2026-04-11")).updatedTo,
    ).toBeTruthy();
    expect((await refused("/customers", `tags=${q("a,b,c,d,e,f")}`)).tags).toBeTruthy(); // more than 5
    expect((await refused("/customers", `tags=${q("<script>x</script>")}`)).tags).toBeTruthy();
    expect((await refused("/customers", `tags=${q("x".repeat(31))}`)).tags).toBeTruthy();
    expect((await refused("/customers", "status=nope")).status).toBeTruthy();
    expect((await refused("/customers", "assignedTo=not-a-uuid")).assignedTo).toBeTruthy();
    expect((await refused("/customers", "archived=maybe")).archived).toBeTruthy();
  });
});

describe("opportunities", () => {
  const list = (qs: string) => names(`/opportunities?${qs}&limit=100`, "title");
  it("filters: stage, owner, customer, close range, amount range (inclusive), search, and combinations", async () => {
    expect(sorted(await list(""))).toEqual([
      "Deal five",
      "Deal four",
      "Deal one",
      "Deal three",
      "Deal two",
    ]);
    expect(sorted(await list("stage=new"))).toEqual(["Deal five", "Deal one"]);
    expect(sorted(await list(`assignedTo=${owner.id}`))).toEqual(["Deal four", "Deal one"]);
    expect(sorted(await list(`customerId=${ids.alpha}`))).toEqual(["Deal one", "Deal two"]);
    expect(sorted(await list("closeFrom=2026-12-15&closeTo=2027-01-10"))).toEqual([
      "Deal three",
      "Deal two",
    ]);
    expect(sorted(await list("closeFrom=2027-01-11"))).toEqual(["Deal four"]);
    expect(sorted(await list("amountMin=250000"))).toEqual(["Deal four", "Deal three", "Deal two"]);
    expect(sorted(await list("amountMax=100000"))).toEqual(["Deal five", "Deal one"]);
    expect(sorted(await list("amountMin=100000&amountMax=250000"))).toEqual([
      "Deal one",
      "Deal three",
      "Deal two",
    ]);
    expect(await list("amountMin=250000&amountMax=250000&sort=title&order=asc")).toEqual([
      "Deal three",
      "Deal two",
    ]);
    expect(await list("amountMin=0&amountMax=0")).toEqual(["Deal five"]);
    expect(await list(`customerId=${ids.bravo}&amountMin=500000`)).toEqual(["Deal four"]);
    expect(await list("q=deal%20four")).toEqual(["Deal four"]);
  });
  it("sorts by every whitelisted column, both ways", async () => {
    expect(await list("sort=title&order=asc")).toEqual([
      "Deal five",
      "Deal four",
      "Deal one",
      "Deal three",
      "Deal two",
    ]);
    expect(await list("sort=title&order=desc")).toEqual([
      "Deal two",
      "Deal three",
      "Deal one",
      "Deal four",
      "Deal five",
    ]);
    expect((await list("sort=amount_cents&order=desc"))[0]).toBe("Deal four");
    expect((await list("sort=amount_cents&order=asc"))[0]).toBe("Deal five");
    expect((await list("sort=expected_close_date&order=asc")).slice(0, 4)).toEqual([
      "Deal one",
      "Deal two",
      "Deal three",
      "Deal four",
    ]); // no date sorts last
    expect((await list("sort=expected_close_date&order=desc")).slice(0, 4)).toEqual([
      "Deal four",
      "Deal three",
      "Deal two",
      "Deal one",
    ]);
    expect(await list("sort=created_at&order=asc")).toEqual([
      "Deal one",
      "Deal two",
      "Deal three",
      "Deal four",
      "Deal five",
    ]);
    expect(await list("sort=created_at&order=desc")).toEqual([
      "Deal five",
      "Deal four",
      "Deal three",
      "Deal two",
      "Deal one",
    ]);
    expect((await list("sort=updated_at&order=desc")).length).toBe(5);
    expect((await list("sort=stage&order=asc")).length).toBe(5);
  });
  it("422 with field errors for bad values", async () => {
    expect((await refused("/opportunities", "amountMin=-1")).amountMin).toBeTruthy();
    expect((await refused("/opportunities", "amountMin=12.5")).amountMin).toBeTruthy();
    expect((await refused("/opportunities", "amountMax=abc")).amountMax).toBeTruthy();
    expect((await refused("/opportunities", "amountMax=999999999999")).amountMax).toBeTruthy(); // 12 digits
    expect((await refused("/opportunities", "amountMin=500&amountMax=100")).amountMax).toBeTruthy();
    expect(
      (await refused("/opportunities", "closeFrom=2027-01-02&closeTo=2027-01-01")).closeTo,
    ).toBeTruthy();
    expect((await refused("/opportunities", "closeTo=2027-02-30")).closeTo).toBeTruthy();
    expect((await refused("/opportunities", "stage=won-ish")).stage).toBeTruthy();
    expect((await refused("/opportunities", "customerId=1")).customerId).toBeTruthy();
  });
});

describe("tasks", () => {
  const list = (qs: string) => names(`/tasks?${qs}&limit=100`, "title");
  it("filters: status, priority, owner, me, overdue, due soon, due range (inclusive), related record, search", async () => {
    expect(sorted(await list(""))).toEqual([
      "Task five",
      "Task four",
      "Task one",
      "Task three",
      "Task two",
    ]);
    expect(sorted(await list("status=todo"))).toEqual(["Task five", "Task one"]);
    expect(await list("status=done")).toEqual(["Task four"]);
    expect(sorted(await list("priority=medium"))).toEqual(["Task five", "Task four"]);
    expect(sorted(await list(`assignedTo=${owner.id}`))).toEqual(["Task four", "Task one"]);
    expect(await list(`assignedTo=${member.id}`)).toEqual(["Task three"]);
    expect(sorted(await list("assignedToMe=true"))).toEqual(["Task four", "Task one"]);
    expect(sorted(await list("overdue=true"))).toEqual(["Task one", "Task three", "Task two"]); // before today, not done
    expect(await list("dueSoon=true")).toEqual([]);
    expect(sorted(await list("dueFrom=2026-06-15&dueTo=2026-06-20"))).toEqual([
      "Task three",
      "Task two",
    ]); // both ends included
    expect(await list("dueFrom=2026-06-16&dueTo=2026-06-20")).toEqual(["Task three"]);
    expect(sorted(await list("dueFrom=2026-01-01"))).toEqual([
      "Task five",
      "Task one",
      "Task three",
      "Task two",
    ]); // no due date never matches
    expect(sorted(await list("dueTo=2026-06-15"))).toEqual(["Task one", "Task two"]);
    expect(await list(`customerId=${ids.bravo}`)).toEqual(["Task two"]);
    expect(await list(`opportunityId=${ids.o1}`)).toEqual(["Task five"]);
    expect(await list("q=THREE")).toEqual(["Task three"]);
    expect(await list("status=in_progress&priority=urgent&dueFrom=2026-06-01")).toEqual([
      "Task two",
    ]);
  });
  it("sorts by every whitelisted column, both ways (no due date sorts last)", async () => {
    expect(await list("sort=due_date&order=asc")).toEqual([
      "Task one",
      "Task two",
      "Task three",
      "Task five",
      "Task four",
    ]);
    expect(await list("sort=due_date&order=desc")).toEqual([
      "Task five",
      "Task three",
      "Task two",
      "Task one",
      "Task four",
    ]);
    expect((await list("sort=priority&order=desc"))[0]).toBe("Task two"); // urgent first
    expect((await list("sort=priority&order=asc"))[0]).toBe("Task one"); // low first
    expect(await list("sort=title&order=asc")).toEqual([
      "Task five",
      "Task four",
      "Task one",
      "Task three",
      "Task two",
    ]);
    expect(await list("sort=title&order=desc")).toEqual([
      "Task two",
      "Task three",
      "Task one",
      "Task four",
      "Task five",
    ]);
    expect(await list("sort=created_at&order=asc")).toEqual([
      "Task one",
      "Task two",
      "Task three",
      "Task four",
      "Task five",
    ]);
    expect(await list("sort=created_at&order=desc")).toEqual([
      "Task five",
      "Task four",
      "Task three",
      "Task two",
      "Task one",
    ]);
    expect((await list("sort=updated_at&order=asc")).length).toBe(5);
  });
  it("422 with field errors for bad values", async () => {
    expect((await refused("/tasks", "dueFrom=yesterday")).dueFrom).toBeTruthy();
    expect((await refused("/tasks", "dueFrom=2026-06-20&dueTo=2026-06-15")).dueTo).toBeTruthy();
    expect((await refused("/tasks", "priority=asap")).priority).toBeTruthy();
    expect((await refused("/tasks", "overdue=yes")).overdue).toBeTruthy();
    expect((await refused("/tasks", "opportunityId=x")).opportunityId).toBeTruthy();
  });
});

describe("quotes", () => {
  const list = (qs: string) => names(`/quotes?${qs}&limit=100`, "title");
  it("filters: status, customer, deal, issue range, valid range (inclusive), search, and combinations", async () => {
    expect(sorted(await list(""))).toEqual(["Quote four", "Quote one", "Quote three", "Quote two"]);
    expect(sorted(await list("status=draft"))).toEqual(["Quote four", "Quote one"]);
    expect(await list("status=sent")).toEqual(["Quote two"]);
    expect(await list("status=approved")).toEqual(["Quote three"]);
    expect(await list("status=expired")).toEqual([]);
    expect(sorted(await list(`customerId=${ids.bravo}`))).toEqual([
      "Quote four",
      "Quote three",
      "Quote two",
    ]);
    expect(await list(`opportunityId=${ids.o3}`)).toEqual(["Quote four"]);
    expect(sorted(await list("issueFrom=2026-10-10&issueTo=2026-10-20"))).toEqual([
      "Quote three",
      "Quote two",
    ]);
    expect(await list("issueFrom=2026-11-01")).toEqual(["Quote four"]);
    expect(sorted(await list("validFrom=2026-11-10&validTo=2026-12-01"))).toEqual([
      "Quote four",
      "Quote two",
    ]);
    expect(await list("validTo=2026-10-31")).toEqual(["Quote one"]);
    expect(sorted(await list("validFrom=2026-01-01"))).toEqual([
      "Quote four",
      "Quote one",
      "Quote two",
    ]); // no end date never matches
    expect(await list(`customerId=${ids.bravo}&status=draft&validFrom=2026-11-15`)).toEqual([
      "Quote four",
    ]);
    expect(await list("q=two")).toEqual(["Quote two"]);
  });
  it("sorts by every whitelisted column, both ways", async () => {
    expect(await list("sort=quote_number&order=asc")).toEqual([
      "Quote one",
      "Quote two",
      "Quote three",
      "Quote four",
    ]);
    expect(await list("sort=quote_number&order=desc")).toEqual([
      "Quote four",
      "Quote three",
      "Quote two",
      "Quote one",
    ]);
    expect(await list("sort=title&order=asc")).toEqual([
      "Quote four",
      "Quote one",
      "Quote three",
      "Quote two",
    ]);
    expect(await list("sort=total_cents&order=desc")).toEqual([
      "Quote two",
      "Quote three",
      "Quote one",
      "Quote four",
    ]);
    expect(await list("sort=total_cents&order=asc")).toEqual([
      "Quote four",
      "Quote one",
      "Quote three",
      "Quote two",
    ]);
    expect(await list("sort=issue_date&order=asc")).toEqual([
      "Quote one",
      "Quote two",
      "Quote three",
      "Quote four",
    ]);
    expect(await list("sort=issue_date&order=desc")).toEqual([
      "Quote four",
      "Quote three",
      "Quote two",
      "Quote one",
    ]);
    expect(await list("sort=created_at&order=asc")).toEqual([
      "Quote one",
      "Quote two",
      "Quote three",
      "Quote four",
    ]);
    expect((await list("sort=status&order=asc")).length).toBe(4);
    expect((await list("sort=updated_at&order=desc")).length).toBe(4);
  });
  it("422 with field errors for bad values", async () => {
    expect((await refused("/quotes", "validFrom=soon")).validFrom).toBeTruthy();
    expect(
      (await refused("/quotes", "validFrom=2026-12-01&validTo=2026-11-01")).validTo,
    ).toBeTruthy();
    expect(
      (await refused("/quotes", "issueFrom=2026-12-01&issueTo=2026-11-01")).issueTo,
    ).toBeTruthy();
    expect((await refused("/quotes", "status=won")).status).toBeTruthy();
  });
});

describe("every list endpoint: paging, sort whitelist, unknown parameters, injection", () => {
  const endpoints = [
    ["/customers", 5],
    ["/opportunities", 5],
    ["/tasks", 5],
    ["/quotes", 4],
  ] as const;

  it.each(endpoints)(
    "%s: meta has page, limit, total and totalPages; a page past the end is empty with the real total",
    async (path, total) => {
      const res = await get(owner, `${path}?limit=2&page=2`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.meta).toMatchObject({
        page: 2,
        limit: 2,
        total,
        totalPages: Math.ceil(total / 2),
      });
      expect(body.data).toHaveLength(2);
      const last = await (await get(owner, `${path}?limit=2&page=${Math.ceil(total / 2)}`)).json();
      expect(last.data).toHaveLength(total % 2 === 0 ? 2 : 1);
      const past = await (await get(owner, `${path}?limit=2&page=99`)).json();
      expect(past.data).toEqual([]);
      expect(past.meta).toMatchObject({ page: 99, limit: 2, total });
      const defaults = await (await get(owner, path)).json();
      expect(defaults.meta).toMatchObject({ page: 1, limit: 25, total, totalPages: 1 });
    },
  );

  it.each(endpoints)(
    "%s: a page never repeats or skips a row, whatever the order",
    async (path, total) => {
      for (const order of ["asc", "desc"]) {
        const seen: string[] = [];
        for (let page = 1; page <= total; page++) {
          const res = await (
            await get(owner, `${path}?limit=1&page=${page}&order=${order}`)
          ).json();
          seen.push(...res.data.map((r: any) => r.id));
        }
        expect(new Set(seen).size).toBe(total);
      }
    },
  );

  it.each(endpoints)(
    "%s: limit 101, page 0, a non-number, an unknown sort or order, an unknown parameter, and a repeated parameter are 422",
    async (path) => {
      for (const bad of [
        "limit=101",
        "limit=0",
        "limit=abc",
        "page=0",
        "page=-1",
        "page=1.5",
        "sort=password",
        "sort=id",
        "order=sideways",
        "nonsense=1",
        "status=a&status=b",
      ]) {
        const res = await get(owner, `${path}?${bad}`);
        expect(res.status, `${path}?${bad}`).toBe(422);
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
      }
    },
  );

  it.each(endpoints)(
    "%s: injection-style text is rejected or just text, and nothing is dropped",
    async (path, total) => {
      const hostile = [
        "'; drop table customers; --",
        '" or "1"="1',
        "%27%29%3B%20drop%20table%20tasks%3B--",
        "a%,b_c\\d",
        "{x}, null, (y)",
        "../../etc/passwd",
        "\u0000",
      ];
      for (const text of hostile) {
        const res = await get(owner, `${path}?q=${q(text)}`);
        expect([200, 422], `${path} q=${text}`).toContain(res.status);
        if (res.status === 200) expect((await res.json()).data).toEqual([]);
      }
      for (const sort of [
        "updated_at;drop table customers",
        "name) union select 1 --",
        "display_name desc",
      ]) {
        expect((await get(owner, `${path}?sort=${q(sort)}`)).status, sort).toBe(422);
      }
      // nothing was dropped or altered
      expect((await (await get(owner, path)).json()).meta.total).toBe(total);
    },
  );

  it("customers: tags with quotes, braces and commas are parameters, not SQL", async () => {
    for (const tags of ['a"b', "a}b", "{a}", "a\\b", 'x","y', "' OR '1'='1"]) {
      const res = await get(owner, `/customers?tags=${q(tags)}`);
      expect([200, 422], tags).toContain(res.status);
      if (res.status === 200) expect((await res.json()).data).toEqual([]);
    }
    expect((await (await get(owner, "/customers")).json()).meta.total).toBe(5);
  });

  it("a search for a literal percent or underscore matches only those characters", async () => {
    expect((await (await get(owner, "/customers?q=%25")).json()).data).toEqual([]);
    expect((await (await get(owner, "/customers?q=_")).json()).data).toEqual([]);
  });
});
