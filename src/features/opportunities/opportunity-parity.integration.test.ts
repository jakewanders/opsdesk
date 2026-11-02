import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_PROBABILITY,
  STAGES,
  pipelineTotal,
  totalsByStage,
  transitionStage,
  weightedPipeline,
  type Stage,
} from "@/lib/domain/pipeline";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-252] TypeScript and SQL must agree, and every opportunity endpoint keeps its status-code contract.
 *
 * PARITY: the pipeline aggregates and the stage rules exist twice on purpose: in the TypeScript domain module (src/lib/domain/
 * pipeline.ts, which the API's list totals use) and in SQL (the `move_opportunity_stage` function and the table's probability
 * trigger). The aggregate side of this file computes the same numbers with an INDEPENDENT SQL query (bigint arithmetic, half-up
 * rounding written out) over a deterministic spread of awkward deals and requires the API, the SQL and the domain module to
 * agree EXACTLY, with and without filters. If someone changes the rounding, the open/closed split, a default probability or a
 * transition rule in one place only, a test here goes red.
 */
const server = new RealServer();
let owner: Actor, admin: Actor, viewer: Actor, outsider: Actor, other: Actor, guest: Actor;
let org = "";
let orgB = "";
let customer = "";
let customerB = "";
let demo = "";

const hdr = (o: string) => ({ "X-Organization-Id": o });
const api = (actor: Actor | null, method: string, path: string, json?: unknown, o = org) =>
  server.request(`/api/v1/opportunities${path}`, actor, { method, json, headers: hdr(o) });

beforeAll(async () => {
  await server.start();
  [owner, admin, viewer, outsider, other, guest] = await Promise.all([
    server.member("op-par-owner"),
    server.member("op-par-admin"),
    server.member("op-par-viewer"),
    server.member("op-par-outsider"),
    server.member("op-par-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  org = await mk(owner, "Parity Co");
  orgB = await mk(other, "Parity Other Co");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${admin.id}', 'admin'), ('${org}', '${viewer.id}', 'viewer')`,
  );
  const cust = async (actor: Actor, o: string, displayName: string) =>
    (
      await (
        await server.request("/api/v1/customers", actor, { json: { displayName }, headers: hdr(o) })
      ).json()
    ).data.id as string;
  customer = await cust(owner, org, "Parity Customer");
  customerB = await cust(other, orgB, "Other Customer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demo = (await boot.json()).data.organizationId;

  // 180 deterministic deals: every stage, amounts from 1 cent up to the maximum, probabilities 0..100 chosen to expose
  // rounding (x.5 cases), a tenth archived, a fifth assigned. Inserted as the superuser with explicit probabilities.
  psql(`
    insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, closed_at, lost_reason, expected_close_date, assigned_to, archived_at)
    select '${org}', '${customer}', 'Parity deal ' || i, s.stage,
      case when i % 29 = 0 then 100000000000 when i % 31 = 0 then 1 else ((i * 7919) % 4999999) + (i % 7) * 50 + (i % 3) end,
      ((i * 37) % 101),
      case when s.stage in ('won', 'lost') then now() end,
      case when s.stage = 'lost' then 'Parity reason' end,
      (date '2027-01-01' + ((i * 13) % 200)),
      case when i % 5 = 0 then '${owner.id}'::uuid end,
      case when i % 10 = 0 then now() end
    from generate_series(1, 180) i
    cross join lateral (select (array['new','qualified','proposal','negotiation','won','lost'])[(i * 13) % 6 + 1] as stage) s
  `);
}, 600_000);
afterAll(() => server.stop());

type Totals = {
  stageTotals: Record<string, { count: number; amountCents: number }>;
  openPipelineCents: number;
  weightedPipelineCents: number;
};

/** The aggregates computed in SQL on their own (half-up per deal, written out; no shared code with the app). */
function sqlTotals(where: string): Totals {
  const rows = psql(`
    select coalesce(json_object_agg(stage, json_build_object('count', n, 'amountCents', amt)), '{}'::json)::text from (
      select stage, count(*) n, sum(amount_cents) amt from public.opportunities where organization_id = '${org}' and ${where} group by stage) s`);
  const open = psql(`
    select json_build_object(
      'open', coalesce(sum(amount_cents) filter (where stage in ('new','qualified','proposal','negotiation')), 0),
      'weighted', coalesce(sum((amount_cents * probability_percent + 50) / 100) filter (where stage in ('new','qualified','proposal','negotiation')), 0)
    )::text from public.opportunities where organization_id = '${org}' and ${where}`);
  const byStage = JSON.parse(rows) as Record<string, { count: number; amountCents: number }>;
  const stageTotals = Object.fromEntries(
    STAGES.map((s) => [s, byStage[s] ?? { count: 0, amountCents: 0 }]),
  );
  const o = JSON.parse(open) as { open: number; weighted: number };
  return {
    stageTotals,
    openPipelineCents: Number(o.open),
    weightedPipelineCents: Number(o.weighted),
  };
}
/** The same numbers from the TypeScript domain module, on the rows exactly as stored. */
function moduleTotals(where: string): Totals {
  const raw = psql(
    `select coalesce(json_agg(json_build_object('stage', stage, 'amountCents', amount_cents, 'probability', probability_percent)), '[]'::json)::text from public.opportunities where organization_id = '${org}' and ${where}`,
  );
  const rows = JSON.parse(raw) as Array<{ stage: Stage; amountCents: number; probability: number }>;
  return {
    stageTotals: totalsByStage(rows),
    openPipelineCents: pipelineTotal(rows),
    weightedPipelineCents: weightedPipeline(rows),
  };
}
async function apiTotals(qs: string): Promise<Totals> {
  const res = await api(owner, "GET", `?limit=1${qs}`);
  expect(res.status).toBe(200);
  const { meta } = await res.json();
  return {
    stageTotals: meta.stageTotals,
    openPipelineCents: meta.openPipelineCents,
    weightedPipelineCents: meta.weightedPipelineCents,
  };
}

describe("pipeline aggregates: API (TypeScript module) = independent SQL = domain module on the stored rows", () => {
  const CASES: Array<[string, string, string]> = [
    ["no filter (archived hidden)", "", "archived_at is null"],
    ["archived only", "&archived=true", "archived_at is not null"],
    ["archived and active", "&archived=all", "true"],
    ["one stage", "&stage=proposal", "archived_at is null and stage = 'proposal'"],
    ["one owner", "&assignedTo=OWNER", "archived_at is null and assigned_to = 'OWNER'"],
    [
      "close date range",
      "&closeFrom=2027-02-01&closeTo=2027-03-15",
      "archived_at is null and expected_close_date between '2027-02-01' and '2027-03-15'",
    ],
    [
      "search by title",
      "&q=Parity%20deal%201",
      "archived_at is null and title ilike '%parity deal 1%'",
    ],
    [
      "one stage and a range",
      "&stage=negotiation&closeFrom=2027-01-01&closeTo=2027-02-28",
      "archived_at is null and stage = 'negotiation' and expected_close_date between '2027-01-01' and '2027-02-28'",
    ],
  ];
  it("the fixture really contains the awkward cases (x.5 rounding, a 1-cent deal, the maximum, zero percent, archived rows)", () => {
    expect(psql(`select count(*) from public.opportunities where organization_id = '${org}'`)).toBe(
      "180",
    );
    expect(
      psql(
        `select count(*) from public.opportunities where organization_id = '${org}' and amount_cents = 1`,
      ),
    ).not.toBe("0");
    expect(
      psql(
        `select count(*) from public.opportunities where organization_id = '${org}' and amount_cents = 100000000000`,
      ),
    ).not.toBe("0");
    expect(
      psql(
        `select count(*) from public.opportunities where organization_id = '${org}' and (amount_cents * probability_percent) % 100 = 50`,
      ),
    ).not.toBe("0");
    expect(
      psql(
        `select count(*) from public.opportunities where organization_id = '${org}' and probability_percent = 0`,
      ),
    ).not.toBe("0");
    expect(
      psql(
        `select count(*) from public.opportunities where organization_id = '${org}' and archived_at is not null`,
      ),
    ).toBe("18");
    expect(
      new Set(
        psql(
          `select string_agg(distinct stage, ',') from public.opportunities where organization_id = '${org}'`,
        ).split(","),
      ).size,
    ).toBe(6);
  });
  it.each(CASES)("%s", async (_name, qs, where) => {
    const w = where.replaceAll("OWNER", owner.id);
    const fromApi = await apiTotals(qs.replaceAll("OWNER", owner.id));
    const fromSql = sqlTotals(w);
    const fromModule = moduleTotals(w);
    expect(fromApi).toEqual(fromSql);
    expect(fromModule).toEqual(fromSql);
    expect(fromApi.openPipelineCents + 0).toBe(
      (["new", "qualified", "proposal", "negotiation"] as const).reduce(
        (n, s) => n + fromSql.stageTotals[s].amountCents,
        0,
      ),
    );
  });
  it("the weighted pipeline rounds each deal half-up before adding (not the sum), exactly where it matters", async () => {
    const t = await apiTotals("");
    const perDeal = Number(
      psql(
        `select sum((amount_cents * probability_percent + 50) / 100) from public.opportunities where organization_id = '${org}' and archived_at is null and stage in ('new','qualified','proposal','negotiation')`,
      ),
    );
    const ofSum = Math.round(
      Number(
        psql(
          `select sum(amount_cents * probability_percent) from public.opportunities where organization_id = '${org}' and archived_at is null and stage in ('new','qualified','proposal','negotiation')`,
        ),
      ) / 100,
    );
    expect(t.weightedPipelineCents).toBe(perDeal);
    expect(perDeal).not.toBe(ofSum); // the fixture makes the two methods differ, so the test can tell them apart
  });
});

describe("stage rules: the TypeScript module and the SQL function agree on every transition and on the default probabilities", () => {
  const fresh = async (stage: Stage) => {
    const id = psql(
      `insert into public.opportunities (organization_id, customer_id, title, stage, probability_percent, closed_at, lost_reason) values ('${org}', '${customer}', 'Rule ${stage} ${Math.random()}', '${stage}', ${DEFAULT_PROBABILITY[stage]}, ${stage === "won" || stage === "lost" ? "now()" : "null"}, ${stage === "lost" ? "'Old reason'" : "null"}) returning id`,
    ).split("\n")[0];
    return (await (await api(owner, "GET", `/${id}`)).json()).data as {
      id: string;
      updatedAt: string;
    };
  };
  it("the table's own default probability equals the module's for every stage (insert with no probability)", () => {
    for (const stage of STAGES) {
      const closed = stage === "won" || stage === "lost";
      const p = psql(
        `insert into public.opportunities (organization_id, customer_id, title, stage, closed_at, lost_reason) values ('${org}', '${customer}', 'Default ${stage}', '${stage}', ${closed ? "now()" : "null"}, ${stage === "lost" ? "'r'" : "null"}) returning probability_percent`,
      ).split("\n")[0];
      expect(Number(p), stage).toBe(DEFAULT_PROBABILITY[stage]);
    }
  });
  it("all 30 transitions: stage, probability, closed and reason in the database equal transitionStage's, including the reopening rules", async () => {
    let n = 0;
    for (const from of STAGES) {
      for (const to of STAGES) {
        if (from === to) continue;
        const d = await fresh(from);
        const state = {
          stage: from,
          probability: DEFAULT_PROBABILITY[from],
          closedAt: from === "won" || from === "lost" ? new Date() : null,
          lostReason: from === "lost" ? "Old reason" : null,
        };
        const expected = transitionStage(state, to, { reason: "Parity reason", now: new Date() });
        if (!expected.ok) throw new Error("rule refused a valid move");
        const res = await api(admin, "POST", `/${d.id}/stage`, {
          stage: to,
          lostReason: "Parity reason",
          expectedUpdatedAt: d.updatedAt,
        });
        expect(res.status, `${from} to ${to}`).toBe(200);
        const row = psql(
          `select stage || '|' || probability_percent || '|' || (closed_at is not null) || '|' || coalesce(lost_reason, '') from public.opportunities where id = '${d.id}'`,
        );
        expect(row, `${from} to ${to}`).toBe(
          `${expected.next.stage}|${expected.next.probability}|${expected.next.closedAt !== null}|${expected.next.lostReason ?? ""}`,
        );
        n++;
      }
    }
    expect(n).toBe(30);
  }, 120_000);
  it("the lost-reason limit counts characters the same way in the module, the API and the database (500 yes, 501 no, astral characters count once, surrounding blanks do not count)", async () => {
    const ok = "😀".repeat(500);
    const tooLong = "😀".repeat(501);
    for (const [reason, valid] of [
      [ok, true],
      [`  ${ok}  `, true],
      [tooLong, false],
      ["   ", false],
    ] as const) {
      const d = await fresh("proposal");
      expect(
        transitionStage(
          { stage: "proposal", probability: 50, closedAt: null, lostReason: null },
          "lost",
          { reason, now: new Date() },
        ).ok,
        `module ${reason.length}`,
      ).toBe(valid);
      const res = await api(admin, "POST", `/${d.id}/stage`, {
        stage: "lost",
        lostReason: reason,
        expectedUpdatedAt: d.updatedAt,
      });
      expect(res.status === 200, `api ${reason.length}`).toBe(valid);
      expect(
        psql(`select stage from public.opportunities where id = '${d.id}'`),
        `database ${reason.length}`,
      ).toBe(valid ? "lost" : "proposal");
    }
  });
});

describe("status-code contract of every opportunity endpoint (envelope included)", () => {
  const body = { customerId: "", title: "Contract deal", amountCents: 1000 };
  let target: { id: string; updatedAt: string };
  beforeAll(async () => {
    target = (await (await api(owner, "POST", "", { ...body, customerId: customer })).json()).data;
  });
  const errorOf = async (res: Response) =>
    (await res.json()).error as {
      code: string;
      message: string;
      requestId: string;
      fieldErrors?: Record<string, string[]>;
      meta?: { current?: { updatedAt: string } };
    };

  it("success envelopes: { data, meta } for items and lists, nothing for 204", async () => {
    const created = await api(owner, "POST", "", { ...body, customerId: customer });
    expect(created.status).toBe(201);
    expect(Object.keys(await created.json()).sort()).toEqual(["data", "meta"]);
    const list = await api(owner, "GET", "?limit=1");
    expect(list.status).toBe(200);
    const l = await list.json();
    expect(Array.isArray(l.data)).toBe(true);
    expect(l.meta).toMatchObject({ page: 1, limit: 1 });
    const one = await api(owner, "GET", `/${target.id}`);
    expect(one.status).toBe(200);
    expect(Object.keys(await one.json()).sort()).toEqual(["data", "meta"]);
    const del = await api(
      owner,
      "DELETE",
      `/${(await (await api(owner, "POST", "", { ...body, customerId: customer })).json()).data.id}`,
    );
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });
  it("401 UNAUTHENTICATED on every route when signed out", async () => {
    for (const [method, path, json] of [
      ["GET", "", undefined],
      ["POST", "", { ...body, customerId: customer }],
      ["GET", `/${target.id}`, undefined],
      ["PATCH", `/${target.id}`, { title: "x y", expectedUpdatedAt: target.updatedAt }],
      ["DELETE", `/${target.id}`, undefined],
      ["POST", `/${target.id}/stage`, { stage: "won", expectedUpdatedAt: target.updatedAt }],
    ] as const) {
      const res = await api(null, method, path, json);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await errorOf(res)).code).toBe("UNAUTHENTICATED");
    }
  });
  it("403 FORBIDDEN for a viewer on every write route, with nothing changed", async () => {
    const before = psql(
      `select updated_at::text || stage from public.opportunities where id = '${target.id}'`,
    );
    for (const [method, path, json] of [
      ["POST", "", { ...body, customerId: customer }],
      ["PATCH", `/${target.id}`, { title: "viewer edit", expectedUpdatedAt: target.updatedAt }],
      ["DELETE", `/${target.id}`, undefined],
      ["POST", `/${target.id}/stage`, { stage: "won", expectedUpdatedAt: target.updatedAt }],
    ] as const) {
      const res = await api(viewer, method, path, json);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await errorOf(res)).code).toBe("FORBIDDEN");
    }
    expect(
      psql(`select updated_at::text || stage from public.opportunities where id = '${target.id}'`),
    ).toBe(before);
  });
  it("404 for another tenant's deal (the same answer as a missing one), customer and assignee; and for a non-member of the workspace", async () => {
    const missing = await errorOf(await api(owner, "GET", `/${crypto.randomUUID()}`));
    for (const [method, path, json] of [
      ["GET", `/${target.id}`, undefined],
      ["PATCH", `/${target.id}`, { title: "x y", expectedUpdatedAt: target.updatedAt }],
      ["DELETE", `/${target.id}`, undefined],
      ["POST", `/${target.id}/stage`, { stage: "won", expectedUpdatedAt: target.updatedAt }],
    ] as const) {
      const res = await api(other, method, path, json, orgB);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await errorOf(res)).code, `${method} ${path}`).toBe(missing.code);
    }
    const crossCustomer = await api(owner, "POST", "", { ...body, customerId: customerB });
    expect(crossCustomer.status).toBe(404);
    expect((await errorOf(crossCustomer)).code).toBe("CUSTOMER_NOT_FOUND");
    expect(
      (await api(owner, "POST", "", { ...body, customerId: customer, assignedTo: other.id }))
        .status,
    ).toBe(422);
    expect(
      (
        await api(owner, "PATCH", `/${target.id}`, {
          customerId: customerB,
          expectedUpdatedAt: target.updatedAt,
        })
      ).status,
    ).toBe(404);
    for (const actor of [outsider, other]) expect((await api(actor, "GET", "")).status).toBe(404);
    expect(
      psql(`select count(*) from public.opportunities where organization_id = '${orgB}'`),
    ).toBe("0");
  });
  it("400 for a malformed id on every id route", async () => {
    for (const [method, suffix, json] of [
      ["GET", "", undefined],
      ["PATCH", "", { title: "x y", expectedUpdatedAt: target.updatedAt }],
      ["DELETE", "", undefined],
      ["POST", "/stage", { stage: "won", expectedUpdatedAt: target.updatedAt }],
    ] as const)
      expect(
        (await api(owner, method, `/not-a-uuid${suffix}`, json)).status,
        `${method} ${suffix}`,
      ).toBe(400);
  });
  it("409 STALE_EDIT carries the current version for PATCH and for the stage move, and nothing is overwritten", async () => {
    const d = (await (await api(owner, "POST", "", { ...body, customerId: customer })).json()).data;
    const next = (
      await (
        await api(owner, "PATCH", `/${d.id}`, {
          title: "Fresh title",
          expectedUpdatedAt: d.updatedAt,
        })
      ).json()
    ).data;
    const patch = await api(admin, "PATCH", `/${d.id}`, {
      title: "Stale title",
      expectedUpdatedAt: d.updatedAt,
    });
    const stage = await api(admin, "POST", `/${d.id}/stage`, {
      stage: "won",
      expectedUpdatedAt: d.updatedAt,
    });
    for (const res of [patch, stage]) {
      expect(res.status).toBe(409);
      const e = await errorOf(res);
      expect(e.code).toBe("STALE_EDIT");
      expect(e.meta?.current?.updatedAt).toBe(next.updatedAt);
    }
    expect(
      psql(`select title || '|' || stage from public.opportunities where id = '${d.id}'`),
    ).toBe("Fresh title|new");
  });
  it("422 with field errors for each invalid input, and LOST_REASON_REQUIRED for lost without a reason", async () => {
    for (const [json, field] of [
      [{ customerId: customer, title: "x" }, "title"],
      [{ customerId: customer, title: "Valid title", amountCents: -1 }, "amountCents"],
      [{ customerId: customer, title: "Valid title", amountCents: 1.5 }, "amountCents"],
      [
        { customerId: customer, title: "Valid title", probabilityPercent: 101 },
        "probabilityPercent",
      ],
      [
        { customerId: customer, title: "Valid title", expectedCloseDate: "2026-02-30" },
        "expectedCloseDate",
      ],
      [{ customerId: customer, title: "Valid title", stage: "won" }, "stage"],
      [{ title: "No customer" }, "customerId"],
    ] as const) {
      const res = await api(owner, "POST", "", json);
      expect(res.status, JSON.stringify(json)).toBe(422);
      expect(Object.keys((await errorOf(res)).fieldErrors ?? {})).toContain(field);
    }
    const patchStage = await api(owner, "PATCH", `/${target.id}`, {
      stage: "won",
      expectedUpdatedAt: target.updatedAt,
    });
    expect(patchStage.status).toBe(422);
    expect(JSON.stringify(await errorOf(patchStage))).toContain("/stage");
    const lost = await api(owner, "POST", `/${target.id}/stage`, {
      stage: "lost",
      expectedUpdatedAt: target.updatedAt,
    });
    expect(lost.status).toBe(422);
    expect((await errorOf(lost)).code).toBe("LOST_REASON_REQUIRED");
  });
  it("429 DEMO_CAP at the demo's opportunity cap, with a Retry-free, fixed message and nothing written", async () => {
    const demoCustomer = psql(
      `select id from public.customers where organization_id = '${demo}' limit 1`,
    );
    const have = Number(
      psql(`select count(*) from public.opportunities where organization_id = '${demo}'`),
    );
    for (let i = have; i < 30; i++)
      expect(
        (await api(guest, "POST", "", { customerId: demoCustomer, title: `Cap ${i}` }, demo))
          .status,
      ).toBe(201);
    const res = await api(
      guest,
      "POST",
      "",
      { customerId: demoCustomer, title: "Over the cap" },
      demo,
    );
    expect(res.status).toBe(429);
    const e = await errorOf(res);
    expect(e.code).toBe("DEMO_CAP");
    expect(e.message).not.toMatch(/relation|constraint|opportunities_|postgres|select |insert /i);
    expect(
      psql(`select count(*) from public.opportunities where organization_id = '${demo}'`),
    ).toBe("30");
  });
  it("errors never leak SQL, stack traces or other tenants' ids, and every error has a request id", async () => {
    const samples = [
      await api(owner, "GET", `/${crypto.randomUUID()}`),
      await api(viewer, "POST", "", { ...body, customerId: customer }),
      await api(owner, "POST", "", { ...body, customerId: customerB }),
      await api(owner, "POST", "", { title: "x" }),
      await api(null, "GET", ""),
    ];
    for (const res of samples) {
      const text = JSON.stringify(await res.json());
      expect(text).toMatch(/"requestId":"[^"]+"/);
      expect(text).not.toMatch(
        /stack|at .*\.ts|postgres|SQLSTATE|violates|pg_|public\.|constraint/i,
      );
      expect(text).not.toContain(customerB);
      expect(text).not.toContain(orgB);
    }
  });
});
