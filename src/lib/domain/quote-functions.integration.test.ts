import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";
import { calculateQuote } from "./quotes";
import { EDGES, RANDOM, type Vector } from "./quote-vectors";

/**
 * [SIT-230] The quote functions over real HTTP (PostgREST with each user's own token, local Supabase): the database's totals equal the
 * TypeScript module's on every shared vector, 50 concurrent creates give 50 distinct sequential numbers, concurrent edits and
 * transitions cannot both win, only one revision of a quote can be started, and a failed create leaves no trace and no gap.
 */
const server = new RealServer();
let owner: Actor, member: Actor, viewer: Actor, guest: Actor;
let org = "";
let customer = "";
let demoOrg = "";
let demoCustomer = "";

type Out = { ok: boolean; status: number; code: string | null; body: Record<string, unknown> };
const token = (a: Actor) =>
  JSON.parse(Buffer.from(a.cookie.split("=base64-")[1], "base64url").toString())
    .access_token as string;

async function rpc(a: Actor, fn: string, body: Record<string, unknown>): Promise<Out> {
  const res = await fetch(`${server.supabase.apiUrl}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: server.supabase.publishableKey,
      Authorization: `Bearer ${token(a)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    ok: res.ok,
    status: res.status,
    code: res.ok ? null : String(json.details ?? json.code ?? res.status),
    body: json,
  };
}

const items = (n = 1) =>
  Array.from({ length: n }, (_, i) => ({
    description: `Line ${i + 1}`,
    quantity: 1,
    unitPriceCents: 100,
  }));
const create = (a: Actor, over: Record<string, unknown> = {}, orgId = org, cust = customer) =>
  rpc(a, "create_quote_with_items", {
    p_org_id: orgId,
    p_customer_id: cust,
    p_opportunity_id: null,
    p_title: "Test quote",
    p_issue_date: null,
    p_valid_until: null,
    p_tax_rate_bps: 0,
    p_discount_cents: 0,
    p_notes: null,
    p_items: items(),
    ...over,
  });
const numbers = () =>
  psql(
    `select coalesce(string_agg(quote_number, ',' order by quote_number), '') from public.quotes where organization_id = '${org}'`,
  );
const nextNumber = () =>
  Number(psql(`select next_number from public.quote_sequences where organization_id = '${org}'`));

beforeAll(async () => {
  await server.start();
  [owner, member, viewer, guest] = await Promise.all([
    server.member("qf-owner"),
    server.member("qf-member"),
    server.member("qf-viewer"),
    server.guest(),
  ]);
  const res = await server.request("/api/v1/organizations", owner, { json: { name: "Quotes Co" } });
  org = (await res.json()).data.id;
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${member.id}', 'member'), ('${org}', '${viewer.id}', 'viewer')`,
  );
  const c = await server.request("/api/v1/customers", owner, {
    json: { displayName: "Quote Customer" },
    headers: { "X-Organization-Id": org },
  });
  customer = (await c.json()).data.id;
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
  demoCustomer = psql(
    `select id from public.customers where organization_id = '${demoOrg}' order by display_name limit 1`,
  );
}, 400_000);

afterAll(() => server.stop());

describe("totals: the database equals the TypeScript module on every shared vector", () => {
  it.each([
    ["edge cases", EDGES.filter((v) => v.lines.length > 0)],
    ["400 pseudo-random quotes", RANDOM],
  ] as const)(
    "%s",
    async (_name, vectors: readonly Vector[]) => {
      for (const v of vectors) {
        const ts = calculateQuote({
          lines: v.lines.map(([quantity, unitPriceCents]) => ({ quantity, unitPriceCents })),
          discountCents: v.discount,
          taxRateBps: v.bps,
        });
        const res = await create(owner, {
          p_tax_rate_bps: v.bps,
          p_discount_cents: v.discount,
          p_items: v.lines.map(([quantity, price], i) => ({
            description: `Line ${i + 1}`,
            quantity,
            unitPriceCents: price,
          })),
        });
        const label = JSON.stringify(v);
        expect(res.ok, `${label}: ${JSON.stringify(res.body)}`).toBe(true);
        expect([res.body.subtotal_cents, res.body.tax_cents, res.body.total_cents], label).toEqual([
          ts.subtotalCents,
          ts.taxCents,
          ts.totalCents,
        ]);
      }
    },
    300_000,
  );
});

describe("numbering and concurrency", () => {
  it("50 concurrent creates in one workspace get 50 distinct, sequential numbers", async () => {
    const orgB = (
      await (
        await server.request("/api/v1/organizations", owner, { json: { name: "Race Co" } })
      ).json()
    ).data.id as string;
    const custB = (
      await (
        await server.request("/api/v1/customers", owner, {
          json: { displayName: "Race Customer" },
          headers: { "X-Organization-Id": orgB },
        })
      ).json()
    ).data.id as string;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => create(owner, { p_title: `Race ${i}` }, orgB, custB)),
    );
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const got = results.map((r) => r.body.quote_number as string).sort();
    expect(new Set(got).size).toBe(50);
    expect(got).toEqual(
      Array.from({ length: 50 }, (_, i) => `Q-${String(i + 1).padStart(6, "0")}`),
    );
    expect(
      Number(
        psql(`select next_number from public.quote_sequences where organization_id = '${orgB}'`),
      ),
    ).toBe(51);
  }, 120_000);

  it("a mix of valid and invalid concurrent creates uses numbers only for the valid ones, with no gap", async () => {
    const before = nextNumber();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0 ? create(owner) : create(owner, { p_discount_cents: 999_999 }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(15);
    expect(results.filter((r) => !r.ok).every((r) => r.code === "DISCOUNT_TOO_LARGE")).toBe(true);
    expect(nextNumber()).toBe(before + 15);
    const nums = results
      .filter((r) => r.ok)
      .map((r) => Number(String(r.body.quote_number).slice(2)));
    nums.sort((a, b) => a - b);
    expect(nums[nums.length - 1] - nums[0]).toBe(14);
  }, 120_000);

  it("a create refused after its number was taken (a demo past its cap) gives the number back", async () => {
    psql(`update private.app_limits set value = 1 where key = 'demo_cap_quotes'`);
    try {
      const first = await create(guest, {}, demoOrg, demoCustomer);
      const existing = Number(
        psql(`select count(*) from public.quotes where organization_id = '${demoOrg}'`),
      );
      const second = await create(guest, { p_title: "Over the cap" }, demoOrg, demoCustomer);
      expect(first.ok || existing >= 1).toBe(true);
      expect(second.ok).toBe(false);
      expect(second.code).toBe("DEMO_CAP");
    } finally {
      psql(`update private.app_limits set value = 20 where key = 'demo_cap_quotes'`);
    }
    const next = Number(
      psql(`select next_number from public.quote_sequences where organization_id = '${demoOrg}'`),
    );
    const used = Number(
      psql(`select count(*) from public.quotes where organization_id = '${demoOrg}'`),
    );
    // seeded 4 (next 5) plus whatever succeeded: the counter is exactly the quotes made plus one
    expect(next).toBe(
      Number(
        psql(
          `select coalesce(max(substring(quote_number from 3)::int), 0) from public.quotes where organization_id = '${demoOrg}'`,
        ),
      ) + 1,
    );
    expect(used).toBeGreaterThanOrEqual(4);
  });
});

describe("edits, transitions and revisions under concurrency", () => {
  it("eight edits at the same version: one wins, all others are stale-edit conflicts", async () => {
    const q = await create(owner, { p_title: "Edit race" });
    const id = q.body.id as string;
    const edit = (a: Actor, title: string) =>
      rpc(a, "update_draft_quote", {
        p_id: id,
        p_expected_version: 1,
        p_customer_id: customer,
        p_opportunity_id: null,
        p_title: title,
        p_issue_date: null,
        p_valid_until: null,
        p_tax_rate_bps: 0,
        p_discount_cents: 0,
        p_notes: null,
        p_items: items(2),
      });
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) => edit(i % 2 ? owner : member, `Edit ${i}`)),
    );
    expect(all.filter((r) => r.ok)).toHaveLength(1);
    expect(all.filter((r) => !r.ok).every((r) => r.code === "STALE_EDIT")).toBe(true);
    expect(psql(`select version from public.quotes where id = '${id}'`)).toBe("2");
    expect(psql(`select count(*) from public.quote_items where quote_id = '${id}'`)).toBe("2");
  });

  it("two sends at the same version: one wins", async () => {
    const q = await create(owner, { p_title: "Send race" });
    const send = (a: Actor) =>
      rpc(a, "transition_quote", { p_id: q.body.id, p_expected_version: 1, p_to_status: "sent" });
    const [a, b] = await Promise.all([send(owner), send(member)]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(psql(`select status || version from public.quotes where id = '${q.body.id}'`)).toBe(
      "sent2",
    );
  });

  it("only one revision of a quote can be started, however many ask at once", async () => {
    const q = await create(owner, { p_title: "Revise race" });
    await rpc(owner, "transition_quote", {
      p_id: q.body.id,
      p_expected_version: 1,
      p_to_status: "sent",
    });
    const before = psql(
      `select to_jsonb(q)::text from public.quotes q where q.id = '${q.body.id}'`,
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        rpc(i % 2 ? owner : member, "revise_quote", { p_id: q.body.id }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => r.code === "REVISION_EXISTS")).toBe(true);
    expect(psql(`select count(*) from public.quotes where revises_quote_id = '${q.body.id}'`)).toBe(
      "1",
    );
    expect(psql(`select to_jsonb(q)::text from public.quotes q where q.id = '${q.body.id}'`)).toBe(
      before,
    );
  });
});

describe("who may call, over HTTP", () => {
  it("a viewer is refused, a guest cannot reach a real workspace, and an anonymous call is refused", async () => {
    expect((await create(viewer)).code).toBe("FORBIDDEN");
    expect((await create(guest)).code).toBe("ORGANIZATION_NOT_FOUND");
    const anon = await fetch(`${server.supabase.apiUrl}/rest/v1/rpc/create_quote_with_items`, {
      method: "POST",
      headers: { apikey: server.supabase.publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_org_id: org,
        p_customer_id: customer,
        p_opportunity_id: null,
        p_title: "Anon",
        p_issue_date: null,
        p_valid_until: null,
        p_tax_rate_bps: 0,
        p_discount_cents: 0,
        p_notes: null,
        p_items: items(),
      }),
    });
    expect([401, 403]).toContain(anon.status);
  });

  it("client-supplied totals are not accepted: extra named parameters make the call fail and nothing is written", async () => {
    const before = numbers();
    const res = await create(owner, { p_total_cents: 1, p_subtotal_cents: 1 });
    expect(res.ok).toBe(false);
    expect(numbers()).toBe(before);
  });
});
