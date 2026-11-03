import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planBuckets, referenceBuckets, type ReportEvents } from "@/lib/domain/reports";
import { zonedDayStart } from "@/lib/domain/day-range";
import { addDays, todayInZone } from "@/lib/domain/tasks";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-264] GET /api/v1/reports against the real production build and Supabase: the envelope, access and validation rules; that the
 * numbers follow the stored data and never include another workspace; PARITY between the SQL function and the TypeScript reference
 * bucketing (src/lib/domain/reports.ts) in eight time zones, fed the same instants, including every local midnight (and one second
 * before it) across the 2026 clock changes; and response time on a 10,000-row-per-table fixture.
 */
const server = new RealServer();
let owner: Actor, viewer: Actor, outsider: Actor, guest: Actor, other: Actor;
let org = "";
let orgB = "";
const BUDGET_MS = process.env.CI ? 2000 : 800;
const hdr = (o: string) => ({ "X-Organization-Id": o });
const get = (actor: Actor | null, query = "", o = org) =>
  server.request(`/api/v1/reports${query}`, actor, { headers: hdr(o) });
/* eslint-disable @typescript-eslint/no-explicit-any */
const report = async (query = "", o = org, actor: Actor = owner): Promise<any> =>
  (await (await get(actor, query, o)).json()).data;

async function mkOrg(actor: Actor, name: string, timezone: string) {
  const res = await server.request("/api/v1/organizations", actor, { json: { name, timezone } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

/** Straight-to-the-table seeding (as the database owner): triggers are off so back-dated timestamps are kept. */
const seeding = <T>(fn: () => T): T => {
  for (const t of ["customers", "opportunities", "tasks"])
    psql(`alter table public.${t} disable trigger user`);
  try {
    return fn();
  } finally {
    for (const t of ["customers", "opportunities", "tasks"])
      psql(`alter table public.${t} enable trigger user`);
  }
};
const customerIn = (o: string) =>
  seeding(
    () =>
      psql(
        `insert into public.customers (organization_id, display_name) values ('${o}', 'Report customer') returning id`,
      ).split("\n")[0],
  );

beforeAll(async () => {
  await server.start();
  [owner, viewer, outsider, guest] = await Promise.all([
    server.member("rp-owner"),
    server.member("rp-viewer"),
    server.member("rp-outsider"),
    server.guest(),
  ]);
  other = await server.member("rp-other");
  org = await mkOrg(owner, "Reports Co", "UTC");
  orgB = await mkOrg(other, "Reports Other", "UTC");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
  );
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/reports: access and validation [SIT-264]", () => {
  it("401 signed out; 404 for a workspace the caller is not in, and for an unknown one, with no internals", async () => {
    expect((await get(null)).status).toBe(401);
    const res = await get(outsider);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toMatch(/report_summary|SELECT|organizations/i);
    expect((await get(owner, "", crypto.randomUUID())).status).toBe(404);
  });

  it("a viewer and a demo guest can read it", async () => {
    expect((await get(viewer)).status).toBe(200);
    expect((await server.request("/api/v1/reports", guest)).status).toBe(200);
  });

  it("defaults to the last 30 days ending today in the organization's zone, daily, zero-filled, with the metric descriptions", async () => {
    const res = await get(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const { data } = await res.json();
    const today = todayInZone(new Date(), "UTC");
    expect(data.range).toEqual({
      from: addDays(today, -29),
      to: today,
      days: 30,
      bucket: "day",
      preset: 30,
    });
    expect(data.buckets).toHaveLength(30);
    expect(
      data.buckets.every((b: any) => b.opportunitiesCreated === 0 && b.tasksCompleted === 0),
    ).toBe(true);
    expect(data.customersBySource).toEqual({ referral: 0, website: 0, outbound: 0, other: 0 });
    expect(Object.keys(data.opportunitiesByStage)).toEqual([
      "new",
      "qualified",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ]);
    const bases = Object.fromEntries(data.metrics.map((m: any) => [m.key, m.basis]));
    expect(bases).toEqual({
      opportunitiesCreated: "event",
      opportunitiesWon: "event",
      opportunitiesLost: "event",
      tasksCompleted: "event",
      customersBySource: "event",
      opportunitiesByStage: "current",
    });
    expect(data.metrics.every((m: any) => m.label && m.description.length > 20)).toBe(true);
  });

  it("the presets: 7 days is 7 daily buckets, 90 days is 13 weekly buckets", async () => {
    const seven = await report("?range=7");
    expect([seven.range.days, seven.range.bucket, seven.buckets.length]).toEqual([7, "day", 7]);
    const ninety = await report("?range=90");
    expect([
      ninety.range.days,
      ninety.range.bucket,
      ninety.buckets.length,
      ninety.range.preset,
    ]).toEqual([90, "week", 13, 90]);
  });

  it("a custom range is used as given (preset null); 366 days is accepted", async () => {
    const d = await report("?from=2026-03-07&to=2026-03-10");
    expect(d.range).toEqual({
      from: "2026-03-07",
      to: "2026-03-10",
      days: 4,
      bucket: "day",
      preset: null,
    });
    expect((await get(owner, "?from=2026-01-01&to=2027-01-01")).status).toBe(200);
  });

  it("422 with field errors for every invalid range", async () => {
    const cases: Array<[string, string]> = [
      ["?range=14", "range"],
      ["?range=abc", "range"],
      ["?range=7&from=2026-01-01&to=2026-01-02", "range"],
      ["?from=2026-01-01", "to"],
      ["?to=2026-01-01", "from"],
      ["?from=2026-03-10&to=2026-03-09", "to"],
      ["?from=2026-01-01&to=2027-01-02", "to"],
      ["?from=2026-02-30&to=2026-03-02", "from"],
      ["?from=yesterday&to=today", "from"],
      ["?from=2026-1-1&to=2026-1-2", "from"],
    ];
    for (const [qs, field] of cases) {
      const res = await get(owner, qs);
      expect(res.status, qs).toBe(422);
      const body = await res.json();
      expect(body.error.code, qs).toBe("VALIDATION_ERROR");
      expect(Object.keys(body.error.fieldErrors ?? {}), qs).toContain(field);
    }
  });

  it("422 for unknown and repeated parameters, and injection-style text is only ever rejected", async () => {
    for (const qs of [
      "?bogus=1",
      "?range=7&range=30",
      "?from=2026-01-01&from=2026-01-02&to=2026-01-03",
      `?from=${encodeURIComponent("2026-01-01'; drop table customers;--")}&to=2026-01-02`,
      "?range=7%20or%201=1",
    ])
      expect((await get(owner, qs)).status, qs).toBe(422);
    expect((await get(owner)).status).toBe(200);
  });
});

describe("GET /api/v1/reports: the numbers [SIT-264]", () => {
  it("follow the stored data, count only this workspace, and ignore archived records", async () => {
    const day = "2026-06-15"; // inside a custom range, so the test is independent of today
    const c = customerIn(org);
    const cB = customerIn(orgB);
    seeding(() => {
      psql(
        `insert into public.customers (organization_id, display_name, source, created_at) values
          ('${org}', 'ref 1', 'referral', '${day} 12:00+00'), ('${org}', 'ref 2', 'referral', '${day} 13:00+00'), ('${org}', 'web', 'website', '${day} 14:00+00'),
          ('${orgB}', 'B web', 'website', '${day} 14:00+00')`,
      );
      psql(
        `insert into public.customers (organization_id, display_name, source, created_at, archived_at) values ('${org}', 'archived', 'other', '${day} 12:00+00', now())`,
      );
      psql(
        `insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, created_at, closed_at, lost_reason) values
          ('${org}', '${c}', 'new one', 'new', 100, 10, '${day} 10:00+00', null, null),
          ('${org}', '${c}', 'won one', 'won', 4200, 100, '2026-01-01 10:00+00', '${day} 11:00+00', null),
          ('${org}', '${c}', 'lost one', 'lost', 900, 0, '2026-01-01 10:00+00', '${day} 11:30+00', 'Price'),
          ('${orgB}', '${cB}', 'B won', 'won', 77700, 100, '${day} 10:00+00', '${day} 11:00+00', null)`,
      );
      psql(
        `insert into public.tasks (organization_id, title, status, completed_at) values
          ('${org}', 'done 1', 'done', '${day} 09:00+00'), ('${org}', 'done 2', 'done', '${day} 09:30+00'), ('${orgB}', 'B done', 'done', '${day} 09:00+00')`,
      );
    });
    const d = await report(`?from=${day}&to=${day}`);
    expect(d.buckets).toEqual([
      {
        start: day,
        end: day,
        opportunitiesCreated: 1,
        opportunitiesWon: 1,
        opportunitiesLost: 1,
        wonAmountCents: 4200,
        tasksCompleted: 2,
      },
    ]);
    expect(d.customersBySource).toEqual({ referral: 2, website: 1, outbound: 0, other: 0 });
    // current-state numbers ignore the range: the won deal is there although the range is a single day in June
    expect(d.opportunitiesByStage.won).toEqual({ count: 1, amountCents: 4200 });
    expect(d.opportunitiesByStage.new).toEqual({ count: 1, amountCents: 100 });
    // the other workspace sees only its own
    const b = await report(`?from=${day}&to=${day}`, orgB, other);
    expect(b.buckets[0]).toMatchObject({
      opportunitiesCreated: 1,
      opportunitiesWon: 1,
      wonAmountCents: 77700,
      tasksCompleted: 1,
    });
    expect(b.customersBySource.website).toBe(1);
    expect(b.opportunitiesByStage.won).toEqual({ count: 1, amountCents: 77700 });
  });

  it("the next response follows a change made through the API (a stage move to Won)", async () => {
    const customer = (
      await (
        await server.request("/api/v1/customers", owner, {
          json: { displayName: "Live customer" },
          headers: hdr(org),
        })
      ).json()
    ).data;
    const deal = (
      await (
        await server.request("/api/v1/opportunities", owner, {
          json: {
            customerId: customer.id,
            title: "Live deal",
            amountCents: 9900,
            stage: "proposal",
          },
          headers: hdr(org),
        })
      ).json()
    ).data;
    const before = await report("?range=7");
    const sum = (d: any, k: string) => d.buckets.reduce((n: number, b: any) => n + b[k], 0);
    expect(sum(before, "opportunitiesCreated")).toBeGreaterThanOrEqual(1);
    const moved = await server.request(`/api/v1/opportunities/${deal.id}/stage`, owner, {
      method: "POST",
      json: { stage: "won", expectedUpdatedAt: deal.updatedAt },
      headers: hdr(org),
    });
    expect(moved.status).toBe(200);
    const after = await report("?range=7");
    expect(sum(after, "opportunitiesWon")).toBe(sum(before, "opportunitiesWon") + 1);
    expect(sum(after, "wonAmountCents")).toBe(sum(before, "wonAmountCents") + 9900);
    const today = after.buckets.at(-1);
    expect(today.opportunitiesWon).toBeGreaterThanOrEqual(1);
    expect(after.opportunitiesByStage.won.count).toBe(before.opportunitiesByStage.won.count + 1);
    expect(after.opportunitiesByStage.proposal.count).toBe(
      before.opportunitiesByStage.proposal.count - 1,
    );
  });
});

const ZONES = [
  "America/New_York",
  "Europe/London",
  "Australia/Lord_Howe",
  "Pacific/Kiritimati",
  "Asia/Kolkata",
  "America/St_Johns",
  "Pacific/Auckland",
  "UTC",
];
const WINDOW = { from: "2026-02-27", to: "2026-04-08" };

/** Every 97 minutes across the window, plus each local midnight and the second before it, in `zone`. */
function instantsFor(zone: string): Date[] {
  const out = new Map<number, Date>();
  const start = Date.parse(`${WINDOW.from}T00:00:00Z`);
  const end = Date.parse(`${WINDOW.to}T00:00:00Z`);
  for (let t = start; t < end; t += 97 * 60_000) out.set(t, new Date(t));
  for (let d = WINDOW.from; d <= WINDOW.to; d = addDays(d, 1)) {
    const midnight = zonedDayStart(d, zone).getTime();
    out.set(midnight, new Date(midnight));
    out.set(midnight - 1000, new Date(midnight - 1000));
    out.set(midnight + 1000, new Date(midnight + 1000));
  }
  return [...out.values()].sort((a, b) => a.getTime() - b.getTime());
}

describe("parity: SQL buckets equal the TypeScript reference [SIT-264]", () => {
  for (const zone of ZONES) {
    it(`${zone}: daily (clock-change weeks) and weekly (36 days) buckets are identical`, async () => {
      const zoneOwner = await server.member(`rp-zone-${zone.replace(/\W/g, "")}`);
      const o = await mkOrg(zoneOwner, `Parity ${zone}`, zone);
      const c = customerIn(o);
      const instants = instantsFor(zone);
      seeding(() => {
        // the instants travel as one compact array of epoch seconds (a long VALUES list overflows the command line)
        const epochs = `'{${instants.map((d) => Math.floor(d.getTime() / 1000)).join(",")}}'::bigint[]`;
        const src = `unnest(${epochs}) with ordinality as u(e, i)`;
        const old = "timestamptz '2020-01-01 00:00+00'";
        const opp = (
          title: string,
          stage: string,
          amount: string,
          created: string,
          closed: string,
          lost: string,
        ) =>
          psql(
            `insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, created_at, closed_at, lost_reason)
             select '${o}', '${c}', '${title}' || i, '${stage}', ${amount}, 10, ${created}, ${closed}, ${lost} from ${src}`,
          );
        opp("c", "new", "1", "to_timestamp(e)", "null", "null");
        opp("w", "won", "i", old, "to_timestamp(e)", "null");
        opp("l", "lost", "1", old, "to_timestamp(e)", "'Price'");
        psql(
          `insert into public.tasks (organization_id, title, status, completed_at) select '${o}', 't' || i, 'done', to_timestamp(e) from ${src}`,
        );
      });
      const events: ReportEvents = {
        opportunitiesCreated: instants,
        opportunitiesWon: instants.map((at, i) => ({ at, amountCents: i + 1 })),
        opportunitiesLost: instants,
        tasksCompleted: instants,
      };
      for (const range of [
        { from: "2026-03-01", to: "2026-04-05" },
        { from: "2026-03-05", to: "2026-03-12" },
        { from: "2026-03-26", to: "2026-04-05" },
        { from: "2026-03-08", to: "2026-03-08" },
      ]) {
        const d = await report(`?from=${range.from}&to=${range.to}`, o, zoneOwner);
        const plan = planBuckets(range);
        expect(d.range.bucket).toBe(plan.bucket);
        expect(d.buckets, `${zone} ${range.from}..${range.to}`).toEqual(
          referenceBuckets(events, range, zone),
        );
        expect(d.buckets.some((b: any) => b.opportunitiesCreated > 0)).toBe(true);
      }
    }, 120_000);
  }
});

describe("response time on 10,000 rows per table [SIT-264]", () => {
  let big = "";
  let bigOwner: Actor;
  const timings: Array<[string, number]> = [];
  beforeAll(async () => {
    bigOwner = await server.member("rp-big");
    big = await mkOrg(bigOwner, "Reports Big Co", "America/New_York");
    const O = `'${big}'`;
    seeding(() => {
      psql(`insert into public.customers (organization_id, display_name, source, created_at)
        select ${O}, 'Customer ' || lpad(i::text, 5, '0'), (array['referral','website','outbound','other'])[1 + i % 4],
          now() - ((i % 700) || ' days')::interval - ((i % 24) || ' hours')::interval from generate_series(1, 10000) i`);
      psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, closed_at, created_at, lost_reason)
        select ${O}, c.id, 'Deal ' || lpad(i::text, 5, '0'), s.stage, (i * 137) % 5000000, 50,
          case when s.stage in ('won','lost') then now() - ((i % 400) || ' days')::interval else null end,
          now() - ((i % 700) || ' days')::interval, case when s.stage = 'lost' then 'Seeded' else null end
        from generate_series(1, 10000) i
        join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i
        cross join lateral (select (array['new','qualified','proposal','negotiation','won','lost'])[1 + i % 6] as stage) s`);
      psql(`insert into public.tasks (organization_id, title, status, completed_at, created_at)
        select ${O}, 'Task ' || lpad(i::text, 5, '0'), s.status, case when s.status = 'done' then now() - ((i % 500) || ' days')::interval else null end,
          now() - ((i % 700) || ' days')::interval
        from generate_series(1, 10000) i cross join lateral (select (array['todo','in_progress','blocked','done'])[1 + i % 4] as status) s`);
    });
    psql(`analyze public.customers; analyze public.opportunities; analyze public.tasks`);
  }, 300_000);
  afterAll(() => {
    console.log(
      "REPORT TIMINGS (median of 3, 10,000 rows per table, ms)\n" +
        timings.map(([l, ms]) => `  ${String(ms).padStart(5)}  ${l}`).join("\n"),
    );
  });

  for (const [label, qs] of [
    ["7 days", "?range=7"],
    ["30 days", "?range=30"],
    ["90 days (weekly)", "?range=90"],
    ["366 days (weekly)", "?from=2025-11-03&to=2026-11-03"],
  ] as const) {
    it(`${label} answers within ${BUDGET_MS} ms and equals the database's own counts`, async () => {
      const runs: number[] = [];
      let data: any;
      for (let i = 0; i < 4; i++) {
        const t = performance.now();
        const res = await get(bigOwner, qs, big);
        runs.push(performance.now() - t);
        expect(res.status).toBe(200);
        data = (await res.json()).data;
      }
      runs.shift();
      runs.sort((a, b) => a - b);
      timings.push([label, Math.round(runs[1])]);
      expect(runs[1], `${label}: ${Math.round(runs[1])} ms`).toBeLessThanOrEqual(BUDGET_MS);
      // the totals equal a direct query over the same local-day bounds
      const lo = `((timestamp '${data.range.from}') at time zone 'America/New_York')`;
      const hi = `((timestamp '${data.range.to}' + interval '1 day') at time zone 'America/New_York')`;
      const direct = (sql: string) => Number(psql(sql));
      const sum = (k: string) => data.buckets.reduce((n: number, b: any) => n + b[k], 0);
      expect(sum("opportunitiesCreated")).toBe(
        direct(
          `select count(*) from public.opportunities where organization_id = '${big}' and created_at >= ${lo} and created_at < ${hi}`,
        ),
      );
      expect(sum("opportunitiesWon")).toBe(
        direct(
          `select count(*) from public.opportunities where organization_id = '${big}' and stage = 'won' and closed_at >= ${lo} and closed_at < ${hi}`,
        ),
      );
      expect(sum("tasksCompleted")).toBe(
        direct(
          `select count(*) from public.tasks where organization_id = '${big}' and completed_at >= ${lo} and completed_at < ${hi}`,
        ),
      );
      expect(Object.values(data.customersBySource).reduce((n: number, v: any) => n + v, 0)).toBe(
        direct(
          `select count(*) from public.customers where organization_id = '${big}' and created_at >= ${lo} and created_at < ${hi}`,
        ),
      );
    }, 120_000);
  }
});
