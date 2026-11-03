import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** The quote endpoints over real HTTP (production build, local Supabase), across roles and tenants (SIT-238, PRD 11.3). */
const server = new RealServer();
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
let customerA = "";
let customerA2 = "";
let customerB = "";
let demoCustomer = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hdr = (org: string) => ({ "X-Organization-Id": org });
const call = (
  actor: Actor | null,
  method: string,
  path: string,
  json?: unknown,
  org = orgA,
  headers: Record<string, string> = {},
) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: { ...hdr(org), ...headers } });
const body = async (res: Response): Promise<any> => res.json();
const LINES = [
  { description: "Widget", quantity: 2, unitPriceCents: 1999 },
  { description: "Gadget", quantity: 1, unitPriceCents: 5000 },
];
const draft = (over: Record<string, unknown> = {}) => ({
  customerId: customerA,
  title: "API quote",
  taxRateBps: 825,
  discountCents: 500,
  items: LINES,
  ...over,
});
async function makeQuote(
  actor = owner,
  over: Record<string, unknown> = {},
  org = orgA,
): Promise<any> {
  const res = await call(
    actor,
    "POST",
    "/quotes",
    draft({ customerId: org === orgA ? customerA : customerB, ...over }),
    org,
  );
  expect(res.status).toBe(201);
  return (await body(res)).data;
}
const send = async (q: any, actor = owner, org = orgA) =>
  (await body(await call(actor, "POST", `/quotes/${q.id}/transition`, { to: "sent" }, org))).data;

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );
const makeCustomer = async (org: string, actor: Actor, name: string) =>
  (
    await (
      await server.request("/api/v1/customers", actor, {
        json: { displayName: name },
        headers: hdr(org),
      })
    ).json()
  ).data.id as string;

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, other, guest] = await Promise.all([
    server.member("qa-owner"),
    server.member("qa-admin"),
    server.member("qa-member"),
    server.member("qa-viewer"),
    server.member("qa-outsider"),
    server.member("qa-other"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Quotes API Co A");
  orgB = await createOrg(other, "Quotes API Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  customerA = await makeCustomer(orgA, owner, "Acme Quotes");
  customerA2 = await makeCustomer(orgA, owner, "Second Quotes");
  customerB = await makeCustomer(orgB, other, "Globex Quotes");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
  demoCustomer = psql(
    `select id from public.customers where organization_id = '${demoOrg}' order by display_name limit 1`,
  );
}, 400_000);

afterAll(() => server.stop());

describe("POST /api/v1/quotes", () => {
  it("201: creates a draft with server-computed totals and the next number", async () => {
    const res = await call(
      owner,
      "POST",
      "/quotes",
      draft({ issueDate: "2026-11-02", validUntil: "2026-12-02", notes: "Net 30" }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const { data } = await body(res);
    expect(data).toMatchObject({
      quoteNumber: "Q-000001",
      status: "draft",
      version: 1,
      currency: "USD",
      customerName: "Acme Quotes",
      subtotalCents: 8998,
      discountCents: 500,
      taxRateBps: 825,
      taxCents: 701,
      totalCents: 9199,
      issueDate: "2026-11-02",
      validUntil: "2026-12-02",
      notes: "Net 30",
      revisesQuoteId: null,
      revises: null,
      revisions: [],
    });
    expect(data.items.map((i: any) => [i.position, i.description, i.lineTotalCents])).toEqual([
      [1, "Widget", 3998],
      [2, "Gadget", 5000],
    ]);
    expect(data.statusHistory.map((h: any) => h.status)).toEqual(["draft"]);
    expect(data.createdBy).toBe(owner.id);
  });

  it("201: an admin, a member and numbers continue in order", async () => {
    const a = await makeQuote(admin);
    const m = await makeQuote(member);
    expect([a.quoteNumber, m.quoteNumber]).toEqual(["Q-000002", "Q-000003"]);
  });

  it("422: a total, subtotal, tax, number, status or version in the body is refused, never trusted or ignored", async () => {
    for (const extra of [
      { totalCents: 1 },
      { subtotalCents: 1 },
      { taxCents: 1 },
      { quoteNumber: "Q-999999" },
      { status: "sent" },
      { version: 5 },
      { organizationId: orgB },
    ]) {
      const res = await call(owner, "POST", "/quotes", draft(extra));
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect((await body(res)).error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("422: every field rule, with field errors", async () => {
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ items: [] }, "items"],
      [{ items: undefined }, "items"],
      [{ items: [{ description: "x", quantity: 1, unitPriceCents: 1 }] }, "items.0.description"],
      [{ items: [{ description: "Widget", quantity: 0, unitPriceCents: 1 }] }, "items.0.quantity"],
      [
        { items: [{ description: "Widget", quantity: 1.5, unitPriceCents: 1 }] },
        "items.0.quantity",
      ],
      [
        { items: [{ description: "Widget", quantity: 100001, unitPriceCents: 1 }] },
        "items.0.quantity",
      ],
      [
        { items: [{ description: "Widget", quantity: 1, unitPriceCents: -1 }] },
        "items.0.unitPriceCents",
      ],
      [
        { items: [{ description: "Widget", quantity: 1, unitPriceCents: 100000001 }] },
        "items.0.unitPriceCents",
      ],
      [
        { items: [{ description: "Widget", quantity: "2", unitPriceCents: 1 }] },
        "items.0.quantity",
      ],
      [
        {
          items: Array.from({ length: 101 }, () => ({
            description: "Line",
            quantity: 1,
            unitPriceCents: 1,
          })),
        },
        "items",
      ],
      [{ taxRateBps: 10001 }, "taxRateBps"],
      [{ taxRateBps: 8.25 }, "taxRateBps"],
      [{ discountCents: -1 }, "discountCents"],
      [{ title: "x" }, "title"],
      [{ issueDate: "2026-02-30" }, "issueDate"],
      [{ validUntil: "next month" }, "validUntil"],
      [{ customerId: "not-a-uuid" }, "customerId"],
    ];
    for (const [over, field] of bad) {
      const res = await call(owner, "POST", "/quotes", draft(over));
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(
        Object.keys((await body(res)).error.fieldErrors ?? {}),
        JSON.stringify(over),
      ).toContain(field);
    }
  });

  it("422: business rules the database enforces come back with a code", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ discountCents: 999999 }, "DISCOUNT_TOO_LARGE"],
      [{ customerId: customerB }, "CUSTOMER_NOT_FOUND"],
      [{ validUntil: "2020-01-01", issueDate: "2026-01-01" }, "INVALID_DATES"],
    ];
    for (const [over, code] of cases) {
      const res = await call(owner, "POST", "/quotes", draft(over));
      expect(res.status, code).toBe(422);
      expect((await body(res)).error.code).toBe(code);
    }
  });

  it("a refusal consumes no number: the next quote follows without a gap", async () => {
    const before = Number(
      psql(`select next_number from public.quote_sequences where organization_id = '${orgA}'`),
    );
    await call(owner, "POST", "/quotes", draft({ discountCents: 999999 }));
    await call(owner, "POST", "/quotes", draft({ customerId: customerB }));
    const q = await makeQuote(owner);
    expect(q.quoteNumber).toBe(`Q-${String(before).padStart(6, "0")}`);
  });

  it("an Idempotency-Key makes a retry return the original quote; the same key with another body is 422", async () => {
    const key = `quote-key-${Date.now()}-abcdef`;
    const first = await call(owner, "POST", "/quotes", draft({ title: "Idempotent" }), orgA, {
      "Idempotency-Key": key,
    });
    const second = await call(owner, "POST", "/quotes", draft({ title: "Idempotent" }), orgA, {
      "Idempotency-Key": key,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await body(second)).data.id).toBe((await body(first)).data.id);
    expect(
      Number(
        psql(
          `select count(*) from public.quotes where organization_id = '${orgA}' and title = 'Idempotent'`,
        ),
      ),
    ).toBe(1);
    const reused = await call(owner, "POST", "/quotes", draft({ title: "Different" }), orgA, {
      "Idempotency-Key": key,
    });
    expect(reused.status).toBe(422);
    expect((await body(reused)).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("20 concurrent creates never collide on a number", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call(owner, "POST", "/quotes", draft({ title: `Concurrent ${i}` })),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = (await Promise.all(results.map(body))).map((b) => b.data.quoteNumber as string);
    expect(new Set(numbers).size).toBe(20);
    const nums = numbers.map((n) => Number(n.slice(2))).sort((a, b) => a - b);
    expect(nums[19] - nums[0]).toBe(19);
  });

  it("403 for a viewer and 404 for a non-member or another workspace's owner; 401 signed out", async () => {
    expect((await call(viewer, "POST", "/quotes", draft())).status).toBe(403);
    expect((await call(outsider, "POST", "/quotes", draft())).status).toBe(404);
    expect((await call(other, "POST", "/quotes", draft())).status).toBe(404);
    expect((await call(null, "POST", "/quotes", draft())).status).toBe(401);
  });

  it("a demo guest creates in their own demo", async () => {
    const res = await call(
      guest,
      "POST",
      "/quotes",
      { customerId: demoCustomer, title: "Demo quote", items: LINES },
      demoOrg,
    );
    expect(res.status).toBe(201);
    expect((await body(res)).data.quoteNumber).toBe("Q-000005"); // the seed used 1 to 4
  });
});

describe("GET /api/v1/quotes", () => {
  it("lists with pagination meta, newest update first, readable by a viewer", async () => {
    const res = await call(viewer, "GET", "/quotes?limit=5");
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data).toHaveLength(5);
    expect(b.meta).toMatchObject({ page: 1, limit: 5 });
    expect(b.meta.total).toBeGreaterThan(20);
    const times = b.data.map((q: any) => Date.parse(q.updatedAt));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(b.data[0]).not.toHaveProperty("items"); // the list carries no lines
  });

  it("filters: status, customer, number and title search, issue date range, archived", async () => {
    const q2 = await makeQuote(owner, {
      title: "Findable Penguin Quote",
      customerId: customerA2,
      issueDate: "2026-03-15",
    });
    await send(q2);
    const by = async (qs: string) =>
      (await body(await call(owner, "GET", `/quotes?${qs}`))).data as any[];
    expect((await by("status=sent")).every((q) => q.status === "sent")).toBe(true);
    expect((await by(`customerId=${customerA2}`)).map((q) => q.id)).toContain(q2.id);
    expect((await by(`customerId=${customerA2}`)).every((q) => q.customerId === customerA2)).toBe(
      true,
    );
    expect((await by("q=penguin")).map((q) => q.id)).toEqual([q2.id]);
    expect((await by(`q=${q2.quoteNumber}`)).map((q) => q.id)).toEqual([q2.id]);
    expect((await by("issueFrom=2026-03-01&issueTo=2026-03-31")).map((q) => q.id)).toEqual([q2.id]);
    psql(`update public.quotes set archived_at = now() where id = '${q2.id}'`);
    expect((await by("q=penguin")).length).toBe(0);
    expect((await by("q=penguin&archived=true")).map((q) => q.id)).toEqual([q2.id]);
    expect((await by("q=penguin&archived=all")).length).toBe(1);
  });

  it("sorts by a whitelisted column and refuses anything else (422)", async () => {
    const asc = (
      await body(await call(owner, "GET", "/quotes?sort=quote_number&order=asc&limit=10"))
    ).data.map((q: any) => q.quoteNumber);
    expect(asc).toEqual([...asc].sort());
    const money = (
      await body(await call(owner, "GET", "/quotes?sort=total_cents&order=desc&limit=10"))
    ).data.map((q: any) => q.totalCents);
    expect(money).toEqual([...money].sort((x: number, y: number) => y - x));
    for (const qs of [
      "sort=password",
      "sort=quote_number;drop",
      "limit=101",
      "page=0",
      "status=paid",
      "nope=1",
      "issueFrom=yesterday",
      "customerId=x",
      "archived=maybe",
    ]) {
      expect((await call(owner, "GET", `/quotes?${qs}`)).status, qs).toBe(422);
    }
  });

  it("a page past the end is empty, and a quote search with SQL-ish text is just text", async () => {
    expect((await body(await call(owner, "GET", "/quotes?page=9999"))).data).toEqual([]);
    expect(
      (await call(owner, "GET", `/quotes?q=${encodeURIComponent("%'; drop table quotes; --")}`))
        .status,
    ).toBe(200);
  });

  it("never lists another workspace's quotes; a non-member gets 404", async () => {
    await makeQuote(other, {}, orgB);
    const mine = (await body(await call(owner, "GET", "/quotes?limit=100"))).data as any[];
    expect(mine.every((q) => q.customerId !== customerB)).toBe(true);
    const theirs = (await body(await call(other, "GET", "/quotes", undefined, orgB))).data as any[];
    expect(theirs.every((q) => q.customerId === customerB)).toBe(true);
    expect((await call(outsider, "GET", "/quotes")).status).toBe(404);
  });

  it("a demo guest sees the 4 seeded quotes", async () => {
    const res = await body(
      await call(guest, "GET", "/quotes?sort=quote_number&order=asc", undefined, demoOrg),
    );
    expect(res.data.slice(0, 4).map((q: any) => [q.quoteNumber, q.status])).toEqual([
      ["Q-000001", "draft"],
      ["Q-000002", "draft"],
      ["Q-000003", "sent"],
      ["Q-000004", "sent"],
    ]);
  });
});

describe("GET /api/v1/quotes/:id", () => {
  it("returns the quote with lines, the chain and the status history; any member can read; others get 404; a bad id is 400", async () => {
    const q = await makeQuote();
    const sent = await send(q);
    const res = await call(viewer, "GET", `/quotes/${q.id}`);
    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data.items).toHaveLength(2);
    expect(data.statusHistory.map((h: any) => h.status)).toEqual(["draft", "sent"]);
    expect(data.version).toBe(sent.version);
    expect((await call(outsider, "GET", `/quotes/${q.id}`)).status).toBe(404);
    expect((await call(other, "GET", `/quotes/${q.id}`, undefined, orgB)).status).toBe(404);
    expect(
      (await call(owner, "GET", `/quotes/${"0".repeat(8)}-0000-4000-8000-000000000000`)).status,
    ).toBe(404);
    expect((await call(owner, "GET", "/quotes/not-a-uuid")).status).toBe(400);
  });
});

describe("PATCH /api/v1/quotes/:id", () => {
  it("200: edits a draft at its version: lines replaced and reordered, totals recomputed, version + 1", async () => {
    const q = await makeQuote();
    const res = await call(member, "PATCH", `/quotes/${q.id}`, {
      expectedVersion: 1,
      title: "Renamed quote",
      discountCents: 1000,
      taxRateBps: 0,
      items: [
        { description: "Second first", quantity: 3, unitPriceCents: 2000 },
        { description: "Then this", quantity: 1, unitPriceCents: 500 },
      ],
    });
    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data).toMatchObject({
      title: "Renamed quote",
      version: 2,
      subtotalCents: 6500,
      taxCents: 0,
      totalCents: 5500,
      customerId: customerA,
    });
    expect(data.items.map((i: any) => i.description)).toEqual(["Second first", "Then this"]);
  });

  it("200: a partial edit keeps everything it did not mention (lines, totals recompute from the kept lines)", async () => {
    const q = await makeQuote();
    const { data } = await body(
      await call(owner, "PATCH", `/quotes/${q.id}`, {
        expectedVersion: 1,
        notes: "Only a note",
        taxRateBps: 0,
      }),
    );
    expect(data).toMatchObject({
      notes: "Only a note",
      title: "API quote",
      subtotalCents: 8998,
      taxCents: 0,
      totalCents: 8498,
      version: 2,
    });
    expect(data.items).toHaveLength(2);
  });

  it("409 STALE_EDIT with the current version in error.meta, and nothing changes", async () => {
    const q = await makeQuote();
    await call(owner, "PATCH", `/quotes/${q.id}`, { expectedVersion: 1, title: "First edit" });
    const stale = await call(admin, "PATCH", `/quotes/${q.id}`, {
      expectedVersion: 1,
      title: "Second edit",
    });
    expect(stale.status).toBe(409);
    const err = (await body(stale)).error;
    expect(err.code).toBe("STALE_EDIT");
    expect(err.meta.current.version).toBe(2);
    expect((await body(await call(owner, "GET", `/quotes/${q.id}`))).data.title).toBe("First edit");
  });

  it("409 QUOTE_LOCKED: a sent quote cannot be edited; revise it instead", async () => {
    const q = await makeQuote();
    const sent = await send(q);
    const res = await call(owner, "PATCH", `/quotes/${q.id}`, {
      expectedVersion: sent.version,
      title: "Too late",
    });
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("QUOTE_LOCKED");
    expect((await body(await call(owner, "GET", `/quotes/${q.id}`))).data.title).toBe("API quote");
  });

  it("422: totals, number or status in the body, an empty patch's version, a bad line; 403 viewer; 404 cross-tenant", async () => {
    const q = await makeQuote();
    for (const extra of [
      { totalCents: 1 },
      { quoteNumber: "Q-1" },
      { status: "sent" },
      { subtotalCents: 1 },
    ]) {
      expect(
        (await call(owner, "PATCH", `/quotes/${q.id}`, { expectedVersion: 1, ...extra })).status,
      ).toBe(422);
    }
    expect((await call(owner, "PATCH", `/quotes/${q.id}`, { title: "No version" })).status).toBe(
      422,
    );
    expect(
      (await call(owner, "PATCH", `/quotes/${q.id}`, { expectedVersion: 1, items: [] })).status,
    ).toBe(422);
    const disc = await call(owner, "PATCH", `/quotes/${q.id}`, {
      expectedVersion: 1,
      discountCents: 999999,
    });
    expect(disc.status).toBe(422);
    expect((await body(disc)).error.code).toBe("DISCOUNT_TOO_LARGE");
    expect(
      (await call(viewer, "PATCH", `/quotes/${q.id}`, { expectedVersion: 1, title: "Nope nope" }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          other,
          "PATCH",
          `/quotes/${q.id}`,
          { expectedVersion: 1, title: "Nope nope" },
          orgB,
        )
      ).status,
    ).toBe(404);
    expect((await body(await call(owner, "GET", `/quotes/${q.id}`))).data.version).toBe(1);
  });

  it("concurrent edits at one version: exactly one wins", async () => {
    const q = await makeQuote();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(i % 2 ? owner : member, "PATCH", `/quotes/${q.id}`, {
          expectedVersion: 1,
          title: `Racer ${i}`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
  });
});

describe("POST /api/v1/quotes/:id/transition", () => {
  it("draft -> sent -> approved, each logged in the status history; a sent quote's version moves", async () => {
    const q = await makeQuote();
    const res = await call(member, "POST", `/quotes/${q.id}/transition`, { to: "sent" });
    expect(res.status).toBe(200);
    const sent = (await body(res)).data;
    expect(sent).toMatchObject({ status: "sent", version: 2 });
    const approved = (
      await body(
        await call(owner, "POST", `/quotes/${q.id}/transition`, {
          to: "approved",
          expectedVersion: 2,
        }),
      )
    ).data;
    expect(approved).toMatchObject({ status: "approved", version: 3 });
    expect(approved.statusHistory.map((h: any) => h.status)).toEqual(["draft", "sent", "approved"]);
  });

  it("each allowed path exists: sent -> rejected and sent -> expired", async () => {
    for (const to of ["rejected", "expired"]) {
      const q = await send(await makeQuote());
      const res = await call(owner, "POST", `/quotes/${q.id}/transition`, { to });
      expect(res.status, to).toBe(200);
      expect((await body(res)).data.status).toBe(to);
    }
  });

  it("409 QUOTE_STATUS_TRANSITION for every other move", async () => {
    const draftQuote = await makeQuote();
    for (const to of ["approved", "rejected", "expired"]) {
      const res = await call(owner, "POST", `/quotes/${draftQuote.id}/transition`, { to });
      expect(res.status, `draft -> ${to}`).toBe(409);
      expect((await body(res)).error.code).toBe("QUOTE_STATUS_TRANSITION");
    }
    const sentQuote = await send(await makeQuote());
    const again = await call(owner, "POST", `/quotes/${sentQuote.id}/transition`, { to: "sent" });
    expect(again.status).toBe(409);
    const done = await body(
      await call(owner, "POST", `/quotes/${sentQuote.id}/transition`, { to: "approved" }),
    );
    for (const to of ["sent", "rejected", "expired", "approved"]) {
      expect(
        (await call(owner, "POST", `/quotes/${done.data.id}/transition`, { to })).status,
        `approved -> ${to}`,
      ).toBe(409);
    }
  });

  it("422 for an unknown or missing target, 409 for a stale version, 403 viewer, 404 cross-tenant", async () => {
    const q = await makeQuote();
    expect((await call(owner, "POST", `/quotes/${q.id}/transition`, { to: "paid" })).status).toBe(
      422,
    );
    expect((await call(owner, "POST", `/quotes/${q.id}/transition`, { to: "draft" })).status).toBe(
      422,
    );
    expect((await call(owner, "POST", `/quotes/${q.id}/transition`, {})).status).toBe(422);
    expect(
      (await call(owner, "POST", `/quotes/${q.id}/transition`, { to: "sent", status: "approved" }))
        .status,
    ).toBe(422);
    const stale = await call(owner, "POST", `/quotes/${q.id}/transition`, {
      to: "sent",
      expectedVersion: 7,
    });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe("STALE_EDIT");
    expect((await call(viewer, "POST", `/quotes/${q.id}/transition`, { to: "sent" })).status).toBe(
      403,
    );
    expect(
      (await call(other, "POST", `/quotes/${q.id}/transition`, { to: "sent" }, orgB)).status,
    ).toBe(404);
    expect((await body(await call(owner, "GET", `/quotes/${q.id}`))).data.status).toBe("draft");
  });

  it("two concurrent sends: exactly one wins", async () => {
    const q = await makeQuote();
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        call(i % 2 ? owner : admin, "POST", `/quotes/${q.id}/transition`, {
          to: "sent",
          expectedVersion: 1,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("a demo guest 'sends' a quote: only the status changes (nothing is delivered)", async () => {
    const q = (
      await body(
        await call(
          guest,
          "POST",
          "/quotes",
          { customerId: demoCustomer, title: "Demo send", items: LINES },
          demoOrg,
        ),
      )
    ).data;
    const res = await call(guest, "POST", `/quotes/${q.id}/transition`, { to: "sent" }, demoOrg);
    expect(res.status).toBe(200);
    expect((await body(res)).data.status).toBe("sent");
  });
});

describe("POST /api/v1/quotes/:id/revise", () => {
  it("201: a sent quote becomes a new draft with a new number that points back; the original is untouched", async () => {
    const q = await makeQuote();
    const sent = await send(q);
    const before = (await body(await call(owner, "GET", `/quotes/${q.id}`))).data;
    const res = await call(member, "POST", `/quotes/${q.id}/revise`);
    expect(res.status).toBe(201);
    const { data } = await body(res);
    expect(data).toMatchObject({
      status: "draft",
      version: 1,
      revisesQuoteId: q.id,
      title: q.title,
      subtotalCents: sent.subtotalCents,
      totalCents: sent.totalCents,
    });
    expect(data.quoteNumber).not.toBe(q.quoteNumber);
    expect(data.revises).toMatchObject({ id: q.id, quoteNumber: q.quoteNumber, status: "sent" });
    expect(data.items.map((i: any) => i.description)).toEqual(["Widget", "Gadget"]);
    const after = (await body(await call(owner, "GET", `/quotes/${q.id}`))).data;
    expect(after.revisions.map((r: any) => r.id)).toEqual([data.id]);
    const { revisions: _b, ...beforeRest } = before;
    const { revisions: _a, ...afterRest } = after;
    expect(afterRest).toEqual(beforeRest);
  });

  it("409 for a draft (QUOTE_NOT_REVISABLE) and for a second open revision (REVISION_EXISTS); 403 viewer; 404 cross-tenant", async () => {
    const d = await makeQuote();
    const notRevisable = await call(owner, "POST", `/quotes/${d.id}/revise`);
    expect(notRevisable.status).toBe(409);
    expect((await body(notRevisable)).error.code).toBe("QUOTE_NOT_REVISABLE");
    const s = await send(await makeQuote());
    expect((await call(owner, "POST", `/quotes/${s.id}/revise`)).status).toBe(201);
    const second = await call(owner, "POST", `/quotes/${s.id}/revise`);
    expect(second.status).toBe(409);
    expect((await body(second)).error.code).toBe("REVISION_EXISTS");
    expect((await call(viewer, "POST", `/quotes/${s.id}/revise`)).status).toBe(403);
    expect((await call(other, "POST", `/quotes/${s.id}/revise`, undefined, orgB)).status).toBe(404);
  });

  it("concurrent revisions start exactly one", async () => {
    const s = await send(await makeQuote());
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        call(i % 2 ? owner : member, "POST", `/quotes/${s.id}/revise`),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });
});

describe("errors never leak SQL", () => {
  it("no response body mentions a table, constraint or function name", async () => {
    const q = await makeQuote();
    const responses = [
      await call(owner, "PATCH", `/quotes/${q.id}`, { expectedVersion: 1, discountCents: 999999 }),
      await call(owner, "POST", "/quotes", draft({ customerId: customerB })),
      await call(owner, "POST", `/quotes/${q.id}/transition`, { to: "approved" }),
    ];
    for (const r of responses)
      expect(JSON.stringify(await body(r))).not.toMatch(
        /quotes_|quote_items|constraint|public\.|plpgsql|violates/i,
      );
  });
});

describe("a forced failure leaves nothing half-done [SIT-267]", () => {
  const countAll = (table: string, org: string) =>
    Number(psql(`select count(*) from public.${table} where organization_id = '${org}'`));
  const nextNumber = (org: string) =>
    Number(
      psql(
        `select coalesce((select next_number from public.quote_sequences where organization_id = '${org}'), 1)`,
      ),
    );
  const install = () => {
    psql(
      `create or replace function public.zz_quote_boom() returns trigger language plpgsql as $$ begin if new.description = 'FORCE FAIL' then raise exception 'forced failure'; end if; return new; end $$`,
    );
    psql(
      `create trigger zz_quote_boom before insert on public.quote_items for each row execute function public.zz_quote_boom()`,
    );
  };
  const remove = () => {
    psql(`drop trigger if exists zz_quote_boom on public.quote_items`);
    psql(`drop function if exists public.zz_quote_boom()`);
  };

  it("a create that fails on its second line leaves no quote, no line, no event, and the number is not consumed", async () => {
    const before = {
      quotes: countAll("quotes", orgA),
      items: countAll("quote_items", orgA),
      events: Number(
        psql(
          `select count(*) from public.activity_events where organization_id = '${orgA}' and entity_type = 'quote'`,
        ),
      ),
      next: nextNumber(orgA),
    };
    install();
    try {
      const res = await call(
        owner,
        "POST",
        "/quotes",
        draft({
          title: "Forced failure create",
          discountCents: 0,
          items: [
            { description: "Fine line", quantity: 1, unitPriceCents: 100 },
            { description: "FORCE FAIL", quantity: 1, unitPriceCents: 100 },
          ],
        }),
      );
      expect(res.status).toBe(500);
      expect(JSON.stringify(await body(res))).not.toMatch(
        /quote_items|zz_quote_boom|forced failure/i,
      );
    } finally {
      remove();
    }
    expect(countAll("quotes", orgA)).toBe(before.quotes);
    expect(countAll("quote_items", orgA)).toBe(before.items);
    expect(
      Number(
        psql(
          `select count(*) from public.activity_events where organization_id = '${orgA}' and entity_type = 'quote'`,
        ),
      ),
    ).toBe(before.events);
    expect(
      Number(
        psql(
          `select count(*) from public.quotes where organization_id = '${orgA}' and title = 'Forced failure create'`,
        ),
      ),
    ).toBe(0);
    expect(nextNumber(orgA)).toBe(before.next); // no gap, no corruption
    const next = (
      await body(await call(owner, "POST", "/quotes", draft({ title: "After the failure" })))
    ).data;
    expect(next.quoteNumber).toBe(`Q-${String(before.next).padStart(6, "0")}`);
  });

  it("an edit that fails halfway leaves the draft exactly as it was (lines, totals, version)", async () => {
    const q = await makeQuote();
    const snapshot = async () =>
      JSON.stringify((await body(await call(owner, "GET", `/quotes/${q.id}`))).data);
    const before = await snapshot();
    install();
    try {
      const res = await call(owner, "PATCH", `/quotes/${q.id}`, {
        expectedVersion: q.version,
        title: "Should not stick",
        items: [
          { description: "Replacement one", quantity: 5, unitPriceCents: 999 },
          { description: "FORCE FAIL", quantity: 1, unitPriceCents: 1 },
        ],
      });
      expect(res.status).toBe(500);
    } finally {
      remove();
    }
    expect(await snapshot()).toBe(before);
    // and it can still be edited at the same version afterwards
    const ok = await call(owner, "PATCH", `/quotes/${q.id}`, {
      expectedVersion: q.version,
      title: "Edited after",
    });
    expect(ok.status).toBe(200);
  });

  it("a revision that fails halfway creates no draft and consumes no number", async () => {
    const sent = await makeQuote();
    await send(sent);
    const before = {
      quotes: countAll("quotes", orgA),
      next: nextNumber(orgA),
      items: countAll("quote_items", orgA),
    };
    // the copied lines go through the same trigger: a line named FORCE FAIL on the original makes the copy fail
    psql(`alter table public.quote_items disable trigger user`);
    psql(
      `update public.quote_items set description = 'FORCE FAIL' where quote_id = '${sent.id}' and position = 1`,
    );
    psql(`alter table public.quote_items enable trigger user`);
    install();
    try {
      const res = await call(owner, "POST", `/quotes/${sent.id}/revise`);
      expect(res.status).toBe(500);
    } finally {
      remove();
    }
    expect(countAll("quotes", orgA)).toBe(before.quotes);
    expect(countAll("quote_items", orgA)).toBe(before.items);
    expect(nextNumber(orgA)).toBe(before.next);
    expect(
      Number(psql(`select count(*) from public.quotes where revises_quote_id = '${sent.id}'`)),
    ).toBe(0);
  });
});

describe("demo Send only changes the status [SIT-267]", () => {
  it("nothing but the quote's status, version and update time changes, and exactly one history event is added", async () => {
    const q = (
      await body(
        await call(
          guest,
          "POST",
          "/quotes",
          { customerId: demoCustomer, title: "Demo send snapshot", items: LINES },
          demoOrg,
        ),
      )
    ).data;
    const tables = [
      "customers",
      "opportunities",
      "tasks",
      "quotes",
      "quote_items",
      "import_jobs",
      "invitations",
      "memberships",
    ];
    const counts = () =>
      tables
        .map(
          (t) =>
            `${t}=${psql(`select count(*) from public.${t} where organization_id = '${demoOrg}'`)}`,
        )
        .join(",");
    const events = () =>
      Number(
        psql(`select count(*) from public.activity_events where organization_id = '${demoOrg}'`),
      );
    const content = () =>
      psql(
        `select (to_jsonb(q) - 'status' - 'version' - 'updated_at')::text from public.quotes q where id = '${q.id}'`,
      );
    const itemsNow = () =>
      psql(
        `select coalesce(string_agg(description || quantity || unit_price_cents, ',' order by position), '') from public.quote_items where quote_id = '${q.id}'`,
      );
    const [c0, e0, k0, i0] = [counts(), events(), content(), itemsNow()];
    const res = await call(guest, "POST", `/quotes/${q.id}/transition`, { to: "sent" }, demoOrg);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toMatchObject({ status: "sent", version: q.version + 1 });
    expect(counts()).toBe(c0); // no other record in the workspace appeared or went away
    expect(events()).toBe(e0 + 1); // the one status event
    expect(content()).toBe(k0); // every other column of the quote is as it was
    expect(itemsNow()).toBe(i0);
    expect(psql(`select count(*) from pg_extension where extname in ('pg_net', 'http')`)).toBe("0"); // no way for the database to call out
  });
});
