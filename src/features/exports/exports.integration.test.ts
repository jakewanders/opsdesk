import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv/parse";
import { todayInZone } from "@/lib/domain/tasks";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";
import {
  CUSTOMER_EXPORT_COLUMNS,
  DEMO_MARKER,
  OPPORTUNITY_EXPORT_COLUMNS,
  REPORT_EXPORT_HEADERS,
  TASK_EXPORT_COLUMNS,
} from "./columns";

/**
 * [SIT-269] GET /api/v1/exports/:entity against the real production build and Supabase: access and validation, the file's shape,
 * that it honours exactly the filters and sort the list endpoints honour (compared with the list's own answer), that formula-like
 * and awkward cells come out inert and intact, the demo marker, the 10,000-row cap, chunked streaming over 10,000 rows, and that
 * another workspace's rows are never in the file.
 */
const server = new RealServer();
let owner: Actor, viewer: Actor, outsider: Actor, other: Actor, guest: Actor;
let org = "";
let orgB = "";
const LIMITS = { maxDataRows: 20_000, maxColumns: 50, maxCellLength: 10_000 };
const hdr = (o: string) => ({ "X-Organization-Id": o });
const exp = (actor: Actor | null, entity: string, qs = "", o = org) =>
  server.request(`/api/v1/exports/${entity}${qs}`, actor, { headers: hdr(o) });
/* eslint-disable @typescript-eslint/no-explicit-any */
const list = async (entity: string, qs: string, o = org, actor: Actor = owner): Promise<any[]> => {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const res = await server.request(`/api/v1/${entity}?${qs}&limit=100&page=${page}`, actor, {
      headers: hdr(o),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    out.push(...body.data);
    if (page >= body.meta.totalPages) return out;
  }
};
async function table(res: Response) {
  expect(res.status).toBe(200);
  const rows = parseCsv((await res.text()).replace(/^﻿/, ""), LIMITS);
  const [header, ...data] = rows;
  return { header, data, col: (name: string) => header.indexOf(name) };
}

async function mkOrg(actor: Actor, name: string, timezone = "UTC") {
  const res = await server.request("/api/v1/organizations", actor, { json: { name, timezone } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
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

const NASTY = [
  `=HYPERLINK("http://x")`,
  "+1+1",
  "-2+3",
  "@SUM(A1)",
  "\t=1+1",
  `=cmd|' /C calc'!A0`,
];

beforeAll(async () => {
  await server.start();
  [owner, viewer, outsider, other, guest] = await Promise.all([
    server.member("ex-owner"),
    server.member("ex-viewer"),
    server.member("ex-outsider"),
    server.member("ex-other"),
    server.guest(),
  ]);
  org = await mkOrg(owner, "Export Co", "America/New_York");
  orgB = await mkOrg(other, "Export Other");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
  );
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );

  // customers: awkward text, filters to hit, and another workspace's row
  seeding(() => {
    NASTY.forEach((name, i) =>
      psql(
        `insert into public.customers (organization_id, display_name, email, status, source, tags, notes) values
          ('${org}', $q$${name}$q$, 'nasty${i}@example.com', 'active', 'website', array['vip'], $q$${name}$q$)`,
      ),
    );
    psql(`insert into public.customers (organization_id, display_name, company_name, status, source, tags, notes) values
      ('${org}', 'Comma, Inc.', 'Quote "Co"', 'lead', 'referral', array['north','vip'], E'two\\nlines, "quoted"'),
      ('${org}', 'Ünïcode Ltd', null, 'inactive', 'other', '{}', null),
      ('${org}', 'Archived One', null, 'active', 'other', '{}', null),
      ('${orgB}', 'OTHER WORKSPACE', null, 'active', 'other', '{}', null)`);
    psql(
      `update public.customers set archived_at = now() where organization_id = '${org}' and display_name = 'Archived One'`,
    );
    const c = psql(
      `select id from public.customers where organization_id = '${org}' and display_name = 'Comma, Inc.'`,
    ).split("\n")[0];
    const cB = psql(
      `select id from public.customers where organization_id = '${orgB}' limit 1`,
    ).split("\n")[0];
    psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, expected_close_date, closed_at, lost_reason, description) values
      ('${org}', '${c}', $q$=1+1$q$, 'proposal', 150000, 50, '2026-12-01', null, null, $q$@desc$q$),
      ('${org}', '${c}', 'Small deal', 'new', 500, 10, '2027-01-15', null, null, null),
      ('${org}', '${c}', 'Won deal', 'won', 99900, 100, null, now(), null, null),
      ('${orgB}', '${cB}', 'OTHER DEAL', 'new', 1, 10, null, null, null, null)`);
    psql(`insert into public.tasks (organization_id, title, status, priority, due_date, description) values
      ('${org}', $q$+cmd$q$, 'todo', 'high', '2026-11-20', null),
      ('${org}', 'Call back', 'in_progress', 'medium', '2026-11-25', 'x'),
      ('${org}', 'Old', 'todo', 'low', '2020-01-01', null),
      ('${orgB}', 'OTHER TASK', 'todo', 'low', null, null)`);
  });
}, 400_000);
afterAll(() => server.stop());

describe("access and validation [SIT-269]", () => {
  it("401 signed out; 404 for a workspace the caller is not in; 404 for an unknown entity; no internals leak", async () => {
    expect((await exp(null, "customers")).status).toBe(401);
    expect((await exp(outsider, "customers")).status).toBe(404);
    const res = await exp(owner, "quotes");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_NOT_FOUND");
    for (const bad of ["users", "..%2Fcustomers", "customers.csv", "Customers", "memberships"])
      expect((await exp(owner, bad)).status, bad).toBe(404);
  });

  it("every role that can read can export, a viewer included", async () => {
    for (const entity of ["customers", "opportunities", "tasks", "reports"])
      expect((await exp(viewer, entity)).status, entity).toBe(200);
  });

  it("422 for invalid, unknown and repeated parameters (same schemas as the lists)", async () => {
    for (const [entity, qs] of [
      ["customers", "?status=bogus"],
      ["customers", "?bogus=1"],
      ["customers", "?sort=password"],
      ["customers", "?createdFrom=2026-02-30"],
      ["opportunities", "?amountMin=-1"],
      ["tasks", "?dueFrom=2026-03-10&dueTo=2026-03-09"],
      ["customers", "?bom=maybe"],
      ["reports", "?range=14"],
      ["reports", "?from=2026-01-01"],
    ] as const) {
      const res = await exp(owner, entity, qs);
      expect(res.status, `${entity}${qs}`).toBe(422);
      expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("the file [SIT-269]", () => {
  it("is CSV with an attachment filename of entity and local date, the row count, no caching and fixed headers", async () => {
    const res = await exp(owner, "customers");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const today = todayInZone(new Date(), "America/New_York");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="customers-${today}.csv"`,
    );
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const t = await table(res);
    expect(t.header).toEqual([...CUSTOMER_EXPORT_COLUMNS.map(([h]) => h), "exported_at"]);
    expect(Number(res.headers.get("x-export-rows"))).toBe(t.data.length);
    const stamp = t.data[0][t.col("exported_at")];
    expect(Date.parse(stamp)).not.toBeNaN();
    expect(new Set(t.data.map((r) => r[t.col("exported_at")])).size).toBe(1);
    expect(t.header).not.toContain(DEMO_MARKER);
  });

  it("opportunities and tasks have their own fixed headers", async () => {
    expect((await table(await exp(owner, "opportunities"))).header).toEqual([
      ...OPPORTUNITY_EXPORT_COLUMNS.map(([h]) => h),
      "exported_at",
    ]);
    expect((await table(await exp(owner, "tasks"))).header).toEqual([
      ...TASK_EXPORT_COLUMNS.map(([h]) => h),
      "exported_at",
    ]);
  });

  it("formula-like cells come out inert (a single leading quote) and everything else is intact", async () => {
    const t = await table(await exp(owner, "customers", "?archived=false"));
    const names = t.data.map((r) => r[t.col("display_name")]);
    for (const nasty of NASTY) {
      expect(names, nasty).toContain(`'${nasty}`);
      expect(names, nasty).not.toContain(nasty);
    }
    // no cell in the whole file starts with a formula character
    for (const row of t.data)
      for (const cell of row) expect(cell, cell).not.toMatch(/^[=+\-@\t\r]/);
    const comma = t.data.find((r) => r[t.col("display_name")] === "Comma, Inc.")!;
    expect(comma[t.col("company_name")]).toBe('Quote "Co"');
    expect(comma[t.col("notes")]).toBe('two\nlines, "quoted"');
    expect(comma[t.col("tags")]).toBe("north; vip");
    expect(names).toContain("Ünïcode Ltd");
    const o = await table(await exp(owner, "opportunities"));
    expect(o.data.map((r) => r[o.col("title")])).toContain("'=1+1");
    expect(o.data.map((r) => r[o.col("description")])).toContain("'@desc");
    const tk = await table(await exp(owner, "tasks"));
    expect(tk.data.map((r) => r[tk.col("title")])).toContain("'+cmd");
  });

  it("amounts are whole cents and dates are ISO", async () => {
    const o = await table(await exp(owner, "opportunities", "?stage=proposal"));
    expect(o.data).toHaveLength(1);
    expect(o.data[0][o.col("amount_cents")]).toBe("150000");
    expect(o.data[0][o.col("expected_close_date")]).toBe("2026-12-01");
    expect(o.data[0][o.col("customer_name")]).toBe("Comma, Inc.");
  });

  it("a UTF-8 byte-order mark only when asked", async () => {
    const plain = new Uint8Array(await (await exp(owner, "tasks")).arrayBuffer());
    const bom = new Uint8Array(await (await exp(owner, "tasks", "?bom=true")).arrayBuffer());
    expect(Array.from(plain.slice(0, 3))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(Array.from(bom.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.length).toBe(plain.length + 3);
  });

  it("never contains another workspace's rows, in any entity", async () => {
    for (const entity of ["customers", "opportunities", "tasks"]) {
      const text = await (await exp(owner, entity, "?archived=")).text();
      expect(text, entity).not.toMatch(/OTHER (WORKSPACE|DEAL|TASK)/);
    }
    const mine = await (await exp(other, "customers", "", orgB)).text();
    expect(mine).toContain("OTHER WORKSPACE");
    expect(mine).not.toContain("Comma, Inc.");
  });
});

describe("honours the list's filters and sort [SIT-269]", () => {
  const ids = (t: { data: string[][]; col: (n: string) => number }) =>
    t.data.map((r) => r[t.col("id")]);
  const cases: Array<[string, string]> = [
    ["customers", ""],
    ["customers", "archived=false&status=active"],
    ["customers", "archived=true"],
    ["customers", "tags=vip&sort=display_name&order=asc"],
    ["customers", "q=comma&archived="],
    ["customers", "source=website&sort=created_at&order=asc"],
    ["opportunities", ""],
    ["opportunities", "stage=new"],
    ["opportunities", "amountMin=1000&amountMax=200000&sort=amount_cents&order=asc"],
    ["opportunities", "sort=amount_cents&order=desc"],
    ["tasks", ""],
    ["tasks", "status=todo&sort=title&order=asc"],
    ["tasks", "dueFrom=2026-11-01&dueTo=2026-11-30&sort=due_date&order=asc"],
    ["tasks", "overdue=true"],
  ];
  for (const [entity, qs] of cases)
    it(`${entity}?${qs || "(none)"} equals the list endpoint's rows, in the same order`, async () => {
      const t = await table(await exp(owner, entity, qs ? `?${qs}` : ""));
      const expected = (await list(entity, qs)).map((r) => r.id);
      expect(ids(t)).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });

  it("page and limit are ignored: an export is the whole filtered set", async () => {
    const all = await table(await exp(owner, "customers", "?archived="));
    const limited = await table(await exp(owner, "customers", "?archived=&limit=1&page=3"));
    expect(ids(limited)).toEqual(ids(all));
    expect(all.data.length).toBeGreaterThan(5);
  });

  it("a filter that matches nothing is a header-only file", async () => {
    const t = await table(await exp(owner, "customers", "?q=zzzzzzzz-nothing"));
    expect(t.data).toEqual([]);
    expect(t.header.length).toBeGreaterThan(5);
  });
});

describe("reports [SIT-269]", () => {
  it("exports the displayed report data for the same range, with the same numbers as GET /reports", async () => {
    const qs = "?from=2026-03-01&to=2026-04-05";
    const report = (
      await (await server.request(`/api/v1/reports${qs}`, owner, { headers: hdr(org) })).json()
    ).data;
    const res = await exp(owner, "reports", qs);
    const t = await table(res);
    expect(t.header).toEqual([...REPORT_EXPORT_HEADERS, "exported_at"]);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="reports-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const series = t.data.filter((r) => r[0] === "series");
    expect(series).toHaveLength(report.buckets.length * 5);
    for (const b of report.buckets) {
      const row = series.find((r) => r[2] === b.start && r[4] === "opportunitiesCreated")!;
      expect(row[3]).toBe(b.end);
      expect(Number(row[5])).toBe(b.opportunitiesCreated);
    }
    const bySource = Object.fromEntries(
      t.data.filter((r) => r[0] === "customers_by_source").map((r) => [r[1], Number(r[5])]),
    );
    expect(bySource).toEqual(report.customersBySource);
    const won = t.data.find(
      (r) => r[0] === "deals_by_stage_now" && r[1] === "won" && r[4] === "amount_cents",
    )!;
    expect(Number(won[5])).toBe(report.opportunitiesByStage.won.amountCents);
    expect(Number(res.headers.get("x-export-rows"))).toBe(t.data.length);
  });
});

describe("a demo workspace [SIT-269]", () => {
  it("marks every file: a final 'Sample / fictional data' column on the header and on every row", async () => {
    for (const entity of ["customers", "opportunities", "tasks", "reports"]) {
      const res = await server.request(`/api/v1/exports/${entity}`, guest);
      const t = await table(res);
      const at = t.col(DEMO_MARKER);
      expect(at, entity).toBe(t.header.length - 1);
      expect(t.header[at - 1]).toBe("exported_at");
      expect(t.data.length, entity).toBeGreaterThan(0);
      expect(
        t.data.every((r) => r[at] === DEMO_MARKER),
        entity,
      ).toBe(true);
    }
  });

  it("a real workspace's files never carry it", async () => {
    for (const entity of ["customers", "opportunities", "tasks", "reports"])
      expect(await (await exp(owner, entity)).text(), entity).not.toContain(DEMO_MARKER);
  });
});

describe("size [SIT-269]", () => {
  let big = "";
  let bigOwner: Actor;
  beforeAll(async () => {
    bigOwner = await server.member("ex-big");
    big = await mkOrg(bigOwner, "Export Big Co");
    seeding(() =>
      psql(`insert into public.customers (organization_id, display_name, email, tags, notes, created_at)
        select '${big}', 'Customer ' || lpad(i::text, 5, '0'), 'c' || i || '@example.com', array['t' || (i % 7)], repeat('note, "x" ', 5),
          now() - ((i % 700) || ' days')::interval from generate_series(1, 10000) i`),
    );
  }, 300_000);

  it("exactly 10,000 rows export, streamed in chunks, each row once and in order, quickly", async () => {
    const t0 = performance.now();
    const res = await exp(bigOwner, "customers", "?sort=display_name&order=asc", big);
    const text = await res.text();
    const ms = Math.round(performance.now() - t0);
    console.log(`EXPORT 10,000 customers: ${ms} ms, ${(text.length / 1024 / 1024).toFixed(1)} MB`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("x-export-rows"))).toBe(10_000);
    const rows = parseCsv(text, LIMITS);
    expect(rows).toHaveLength(10_001);
    const names = rows.slice(1).map((r) => r[1]);
    expect(names[0]).toBe("Customer 00001");
    expect(names[9999]).toBe("Customer 10000");
    expect(new Set(rows.slice(1).map((r) => r[0])).size).toBe(10_000);
    expect(rows.slice(1).every((r) => r.length === rows[0].length)).toBe(true);
    expect(ms).toBeLessThan(process.env.CI ? 30_000 : 15_000);
  }, 120_000);

  it("one more row is refused with 422 EXPORT_TOO_LARGE and says how to narrow it; a filter brings it back under", async () => {
    seeding(() =>
      psql(
        `insert into public.customers (organization_id, display_name) values ('${big}', 'The 10,001st')`,
      ),
    );
    const res = await exp(bigOwner, "customers", "", big);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("EXPORT_TOO_LARGE");
    expect(body.error.message).toMatch(/10,001 rows; the limit is 10,000.*filters/);
    const narrowed = await exp(bigOwner, "customers", "?tags=t3", big);
    expect(narrowed.status).toBe(200);
    expect(Number(narrowed.headers.get("x-export-rows"))).toBeGreaterThan(1000);
  }, 120_000);
});
