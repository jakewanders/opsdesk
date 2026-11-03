import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * The list endpoints on a 10,000-row fixture (SIT-250, PRD F15, 11.6): a workspace with 10,000 customers, 10,000 opportunities,
 * 10,000 tasks and 10,000 quotes. Every filter and sort that the lists offer is called for a 100-row page, over real HTTP, against the
 * production build: the answer must be right (the total equals the database's own count) and fast (the median of three calls is at
 * most 800 ms, the budget the dashboard uses). The plans of the selective filters are read with EXPLAIN ANALYZE as the authenticated
 * role and must use the filter's index. The timings and plans are printed so the run is its own record.
 */
const server = new RealServer();
let owner: Actor;
let org = "";
const BUDGET_MS = process.env.CI ? 2000 : 800; // the budget is 800 ms; a shared CI runner is allowed 2.5x
const timings: Array<[string, number, number]> = [];

/* eslint-disable @typescript-eslint/no-explicit-any */
const get = (path: string) =>
  server.request(`/api/v1${path}`, owner, { headers: { "X-Organization-Id": org } });
const count = (sql: string) => Number(psql(sql));

async function measure(label: string, path: string, expectTotal?: number) {
  const runs: number[] = [];
  let body: any;
  for (let i = 0; i < 4; i++) {
    const t = performance.now();
    const res = await get(path);
    runs.push(performance.now() - t);
    expect(res.status, path).toBe(200);
    body = await res.json();
  }
  runs.shift(); // the first call warms the connection and the plan cache
  runs.sort((a, b) => a - b);
  const median = runs[1];
  timings.push([label, Math.round(median), body.meta.total]);
  expect(body.data.length, label).toBeLessThanOrEqual(100);
  if (expectTotal !== undefined) expect(body.meta.total, `${label}: total`).toBe(expectTotal);
  expect(median, `${label}: ${Math.round(median)} ms`).toBeLessThanOrEqual(BUDGET_MS);
}

/** The plan of `sql` as the signed-in owner (row level security applies), with real timings. */
function explain(sql: string, settings = ""): string {
  const claims = JSON.stringify({ sub: owner.id, role: "authenticated" });
  return psql(
    `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims}', true); ${settings}` +
      `explain (analyze, costs off) ${sql}; rollback;`,
  );
}

beforeAll(async () => {
  await server.start();
  owner = await server.member("lp-owner");
  const created = await server.request("/api/v1/organizations", owner, {
    json: { name: "List Performance Co", timezone: "America/New_York" },
  });
  org = (await created.json()).data.id;
  const O = `'${org}'`;
  const you = `'${owner.id}'`;

  psql(`alter table public.customers disable trigger user`);
  psql(`insert into public.customers (organization_id, display_name, status, source, tags, assigned_to, created_at, updated_at)
    select ${O}, 'Customer ' || lpad(i::text, 5, '0'), (array['lead','active','inactive'])[1 + i % 3], (array['referral','website','outbound','other'])[1 + i % 4],
      case when i % 100 = 0 then array['vip','north'] when i % 10 = 0 then array['vip'] when i % 7 = 0 then array['north','south'] else '{}'::text[] end,
      case when i % 10 = 0 then ${you}::uuid else null end,
      now() - ((i % 700) || ' days')::interval - ((i % 24) || ' hours')::interval, now() - ((i % 300) || ' days')::interval
    from generate_series(1, 10000) i`);
  psql(`alter table public.customers enable trigger user`);

  psql(`alter table public.opportunities disable trigger user`);
  psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, expected_close_date, assigned_to, lost_reason, closed_at, created_at, updated_at)
    select ${O}, c.id, 'Deal ' || lpad(i::text, 5, '0'), s.stage, (i * 137) % 5000000, 50, current_date + ((i % 400) - 100),
      case when i % 10 = 0 then ${you}::uuid else null end, case when s.stage = 'lost' then 'Seeded' else null end, case when s.stage in ('won','lost') then now() else null end,
      now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
    from generate_series(1, 10000) i
    join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i
    cross join lateral (select (array['new','qualified','proposal','negotiation','won','lost'])[1 + i % 6] as stage) s`);
  psql(`alter table public.opportunities enable trigger user`);

  psql(`alter table public.tasks disable trigger user`);
  psql(`insert into public.tasks (organization_id, title, status, priority, due_date, assigned_to, customer_id, completed_at, created_at, updated_at)
    select ${O}, 'Task ' || lpad(i::text, 5, '0'), s.status, (array['low','medium','high','urgent'])[1 + i % 4],
      case when i % 10 = 0 then null else current_date + ((i % 730) - 365) end, case when i % 8 = 0 then ${you}::uuid else null end,
      case when i % 3 = 0 then c.id else null end, case when s.status = 'done' then now() else null end,
      now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
    from generate_series(1, 10000) i
    join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i
    cross join lateral (select (array['todo','in_progress','blocked','done'])[1 + i % 4] as status) s`);
  psql(`alter table public.tasks enable trigger user`);

  psql(`alter table public.quotes disable trigger user`);
  psql(`insert into public.quotes (organization_id, customer_id, quote_number, title, status, issue_date, valid_until, created_at, updated_at)
    select ${O}, c.id, 'Q-' || lpad(i::text, 6, '0'), 'Quote ' || lpad(i::text, 5, '0'), (array['draft','sent','approved','rejected','expired'])[1 + i % 5],
      current_date - (i % 700), case when i % 5 = 0 then null else current_date - (i % 700) + (i % 60) end,
      now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
    from generate_series(1, 10000) i
    join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i`);
  psql(`alter table public.quotes enable trigger user`);
  psql(
    `analyze public.customers; analyze public.opportunities; analyze public.tasks; analyze public.quotes`,
  );
}, 600_000);

afterAll(async () => {
  for (const t of ["customers", "opportunities", "tasks", "quotes"])
    psql(`alter table public.${t} enable trigger user`);
  console.log(
    "LIST TIMINGS (median of 3, 100-row page, 10,000 rows per table, ms)\n" +
      timings
        .map(
          ([label, ms, total]) =>
            `${label.padEnd(58)} ${String(ms).padStart(5)} ms   total ${total}`,
        )
        .join("\n"),
  );
  await server.stop();
});

describe("fixture", () => {
  it("has 10,000 rows in each table for the workspace", () => {
    for (const t of ["customers", "opportunities", "tasks", "quotes"])
      expect(count(`select count(*) from public.${t} where organization_id = '${org}'`)).toBe(
        10000,
      );
  });
});

describe("customers on 10,000 rows", () => {
  const O = () => `organization_id = '${org}' and archived_at is null`;
  it("default page, sorts and deep paging", async () => {
    await measure("customers: default page", "/customers?limit=100", 10000);
    await measure(
      "customers: sort display_name",
      "/customers?limit=100&sort=display_name&order=asc",
      10000,
    );
    await measure(
      "customers: sort created_at desc",
      "/customers?limit=100&sort=created_at&order=desc",
      10000,
    );
    await measure("customers: sort status", "/customers?limit=100&sort=status", 10000);
    await measure("customers: page 100 (offset 9,900)", "/customers?limit=100&page=100", 10000);
  });
  it("every filter", async () => {
    await measure(
      "customers: status=lead",
      "/customers?limit=100&status=lead",
      count(`select count(*) from public.customers where ${O()} and status = 'lead'`),
    );
    await measure(
      "customers: source=referral",
      "/customers?limit=100&source=referral",
      count(`select count(*) from public.customers where ${O()} and source = 'referral'`),
    );
    await measure(
      "customers: assignedTo=me",
      `/customers?limit=100&assignedTo=${owner.id}`,
      count(`select count(*) from public.customers where ${O()} and assigned_to is not null`),
    );
    await measure(
      "customers: tags=vip,north",
      "/customers?limit=100&tags=vip,north",
      count(`select count(*) from public.customers where ${O()} and tags @> array['vip','north']`),
    );
    await measure(
      "customers: tags=vip",
      "/customers?limit=100&tags=vip",
      count(`select count(*) from public.customers where ${O()} and tags @> array['vip']`),
    );
    await measure(
      "customers: q=Customer 0012",
      "/customers?limit=100&q=customer%200012",
      count(
        `select count(*) from public.customers where ${O()} and search_text like '%customer 0012%'`,
      ),
    );
    await measure("customers: archived=all", "/customers?limit=100&archived=all", 10000);
    const from = "2026-01-01";
    const to = "2026-01-31";
    await measure(
      "customers: created range (one month, org time)",
      `/customers?limit=100&createdFrom=${from}&createdTo=${to}`,
      count(
        `select count(*) from public.customers where ${O()} and created_at >= ('${from}'::timestamp at time zone 'America/New_York') and created_at < (('${to}'::date + 1)::timestamp at time zone 'America/New_York')`,
      ),
    );
    await measure(
      "customers: updated range + status",
      `/customers?limit=100&updatedFrom=${from}&updatedTo=${to}&status=active`,
      count(
        `select count(*) from public.customers where ${O()} and status = 'active' and updated_at >= ('${from}'::timestamp at time zone 'America/New_York') and updated_at < (('${to}'::date + 1)::timestamp at time zone 'America/New_York')`,
      ),
    );
  });
});

describe("opportunities on 10,000 rows", () => {
  const O = () => `organization_id = '${org}' and archived_at is null`;
  it("default page, sorts and every filter", async () => {
    await measure("opportunities: default page", "/opportunities?limit=100", 10000);
    for (const sort of ["amount_cents", "expected_close_date", "title", "stage", "created_at"])
      await measure(`opportunities: sort ${sort}`, `/opportunities?limit=100&sort=${sort}`, 10000);
    await measure(
      "opportunities: stage=proposal",
      "/opportunities?limit=100&stage=proposal",
      count(`select count(*) from public.opportunities where ${O()} and stage = 'proposal'`),
    );
    await measure(
      "opportunities: assignedTo=me",
      `/opportunities?limit=100&assignedTo=${owner.id}`,
      count(`select count(*) from public.opportunities where ${O()} and assigned_to is not null`),
    );
    await measure(
      "opportunities: amount 1,000,000 to 1,100,000",
      "/opportunities?limit=100&amountMin=1000000&amountMax=1100000",
      count(
        `select count(*) from public.opportunities where ${O()} and amount_cents between 1000000 and 1100000`,
      ),
    );
    await measure(
      "opportunities: amountMin only",
      "/opportunities?limit=100&amountMin=4900000",
      count(`select count(*) from public.opportunities where ${O()} and amount_cents >= 4900000`),
    );
    const closeFrom = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const closeTo = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await measure(
      "opportunities: close range (11 days)",
      `/opportunities?limit=100&closeFrom=${closeFrom}&closeTo=${closeTo}`,
      count(
        `select count(*) from public.opportunities where ${O()} and expected_close_date between '${closeFrom}' and '${closeTo}'`,
      ),
    );
    await measure(
      "opportunities: q=Deal 0012",
      "/opportunities?limit=100&q=deal%200012",
      count(`select count(*) from public.opportunities where ${O()} and title ilike '%deal 0012%'`),
    );
  });
});

describe("tasks on 10,000 rows", () => {
  const O = () => `organization_id = '${org}' and archived_at is null`;
  it("default page, sorts and every filter", async () => {
    await measure("tasks: default page", "/tasks?limit=100", 10000);
    for (const sort of ["priority", "title", "created_at", "updated_at"])
      await measure(`tasks: sort ${sort}`, `/tasks?limit=100&sort=${sort}`, 10000);
    await measure(
      "tasks: status=blocked",
      "/tasks?limit=100&status=blocked",
      count(`select count(*) from public.tasks where ${O()} and status = 'blocked'`),
    );
    await measure(
      "tasks: priority=urgent",
      "/tasks?limit=100&priority=urgent",
      count(`select count(*) from public.tasks where ${O()} and priority = 'urgent'`),
    );
    await measure(
      "tasks: assignedToMe",
      "/tasks?limit=100&assignedToMe=true",
      count(`select count(*) from public.tasks where ${O()} and assigned_to is not null`),
    );
    await measure(
      "tasks: overdue",
      "/tasks?limit=100&overdue=true",
      count(
        `select count(*) from public.tasks where ${O()} and status <> 'done' and due_date < (now() at time zone 'America/New_York')::date`,
      ),
    );
    await measure(
      "tasks: dueSoon",
      "/tasks?limit=100&dueSoon=true",
      count(
        `select count(*) from public.tasks where ${O()} and status <> 'done' and due_date between (now() at time zone 'America/New_York')::date and (now() at time zone 'America/New_York')::date + 7`,
      ),
    );
    const dueFrom = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const dueTo = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
    await measure(
      "tasks: due range (11 days)",
      `/tasks?limit=100&dueFrom=${dueFrom}&dueTo=${dueTo}`,
      count(
        `select count(*) from public.tasks where ${O()} and due_date between '${dueFrom}' and '${dueTo}'`,
      ),
    );
    await measure(
      "tasks: related customer",
      `/tasks?limit=100&customerId=${psql(`select id from public.customers where organization_id = '${org}' order by display_name limit 1 offset 2`)}`,
      1,
    );
    await measure(
      "tasks: q=Task 0012",
      "/tasks?limit=100&q=task%200012",
      count(`select count(*) from public.tasks where ${O()} and title ilike '%task 0012%'`),
    );
  });
});

describe("quotes on 10,000 rows", () => {
  const O = () => `organization_id = '${org}' and archived_at is null`;
  it("default page, sorts and every filter", async () => {
    await measure("quotes: default page", "/quotes?limit=100", 10000);
    for (const sort of ["quote_number", "title", "issue_date", "status", "created_at"])
      await measure(`quotes: sort ${sort}`, `/quotes?limit=100&sort=${sort}`, 10000);
    await measure(
      "quotes: sort total_cents",
      "/quotes?limit=100&sort=total_cents&order=desc",
      10000,
    );
    await measure(
      "quotes: status=sent",
      "/quotes?limit=100&status=sent",
      count(`select count(*) from public.quotes where ${O()} and status = 'sent'`),
    );
    const issueFrom = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const issueTo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    await measure(
      "quotes: issue range (11 days)",
      `/quotes?limit=100&issueFrom=${issueFrom}&issueTo=${issueTo}`,
      count(
        `select count(*) from public.quotes where ${O()} and issue_date between '${issueFrom}' and '${issueTo}'`,
      ),
    );
    await measure(
      "quotes: valid range (11 days)",
      `/quotes?limit=100&validFrom=${issueFrom}&validTo=${issueTo}`,
      count(
        `select count(*) from public.quotes where ${O()} and valid_until between '${issueFrom}' and '${issueTo}'`,
      ),
    );
    await measure(
      "quotes: q=Q-0012",
      "/quotes?limit=100&q=q-0012",
      count(
        `select count(*) from public.quotes where ${O()} and (quote_number ilike '%q-0012%' or title ilike '%q-0012%')`,
      ),
    );
    await measure(
      "quotes: customer + status",
      `/quotes?limit=100&status=draft&customerId=${psql(`select customer_id from public.quotes where organization_id = '${org}' and status = 'draft' limit 1`)}`,
      1,
    );
  });
});

describe("plans: the selective filters use their index (EXPLAIN ANALYZE as the signed-in owner)", () => {
  const plans: Array<[string, string | null, string]> = [];
  afterAll(() =>
    console.log(
      "PLANS\n" +
        plans
          .map(([l, i, p]) => `--- ${l} (expects ${i ?? "a scan of the workspace's rows"})\n${p}`)
          .join("\n"),
    ),
  );
  const O = () => `organization_id = '${org}' and archived_at is null`;
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  it.each([
    [
      "customers: tags vip,north",
      null,
      () =>
        `select * from public.customers where ${O()} and tags @> array['vip','north'] order by updated_at desc, id limit 100`,
    ],
    [
      "customers: created range (a week)",
      "customers_org_created_idx",
      () =>
        `select * from public.customers where ${O()} and created_at >= now() - interval '90 days' and created_at < now() - interval '85 days' order by updated_at desc, id limit 100`,
    ],
    [
      "customers: search",
      null,
      () =>
        `select * from public.customers where ${O()} and search_text ilike '%customer 0012%' order by updated_at desc, id limit 100`,
    ],
    [
      "opportunities: amount range",
      "opportunities_org_amount_idx",
      () =>
        `select * from public.opportunities where ${O()} and amount_cents between 1000000 and 1010000 order by updated_at desc, id limit 100`,
    ],
    [
      "opportunities: close range",
      "opportunities_org_close_date_idx",
      () =>
        `select * from public.opportunities where ${O()} and expected_close_date between '${day(10)}' and '${day(12)}' order by updated_at desc, id limit 100`,
    ],
    [
      "tasks: due range",
      "tasks_org_due_idx",
      () =>
        `select * from public.tasks where ${O()} and due_date between '${day(30)}' and '${day(32)}' order by due_date asc nulls last, id limit 100`,
    ],
    [
      "quotes: issue range",
      "quotes_org_issue_date_idx",
      () =>
        `select * from public.quotes where ${O()} and issue_date between '${day(-40)}' and '${day(-38)}' order by updated_at desc, id limit 100`,
    ],
    [
      "quotes: valid range",
      "quotes_org_valid_until_idx",
      () =>
        `select * from public.quotes where ${O()} and valid_until between '${day(-40)}' and '${day(-38)}' order by updated_at desc, id limit 100`,
    ],
  ])("%s", (label, index, sql) => {
    const plan = explain(sql());
    plans.push([label, index, plan]);
    // tags and search cannot use their indexes under row level security (the membership test must run first, and neither
    // operator is leakproof): they scan the workspace with that test on each row, which has to stay cheap at this size
    if (index) expect(plan, label).toContain(index);
    const ms = Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]);
    expect(ms, `${label}: ${ms} ms`).toBeLessThan(index ? 100 : 250);
  });
});
