import { expect, test } from "@playwright/test";
import { psql } from "../src/test/local-supabase";
import { api, cleanUp, makeUser, makeWorkspace, signIn, type Person } from "./support/local";

/**
 * [P-10, PRD 11.6] Performance verification on a 10,000-row workspace (10,000 customers, opportunities and tasks), warm, against the
 * LOCAL production build and local database. Off by default (it seeds 30,000 rows and takes minutes):
 *
 *   PERF=1 node scripts/e2e.mjs e2e/performance.spec.ts --project=desktop
 *
 * It measures and prints: list API latency over 40 warm calls (p50, p95, max) for a 100-row page, the dashboard and reports APIs,
 * the dashboard page (navigation until the figures are on screen, warm), and a 100-row customer list in the browser (time to 100 rows
 * on screen, and time for a search to replace them). It asserts the PRD budgets: list API p95 < 800 ms, dashboard usable < 3 s.
 * Local numbers: cold starts and provider pauses are excluded by design (every series is warmed first) and a hosted run will differ.
 */
test.skip(!process.env.PERF, "set PERF=1 to run the performance verification");
test.afterAll(cleanUp);

let owner: Person;
let org = "";
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]) };
};
const lines: string[] = [];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  owner = await makeUser("perf");
  org = await makeWorkspace(owner, "Performance Co");
  const O = `'${org}'`;
  const you = `'${owner.id}'`;
  for (const t of ["customers", "opportunities", "tasks"])
    psql(`alter table public.${t} disable trigger user`);
  try {
    psql(`insert into public.customers (organization_id, display_name, status, source, assigned_to, created_at, updated_at)
      select ${O}, 'Customer ' || lpad(i::text, 5, '0'), (array['lead','active','inactive'])[1 + i % 3], (array['referral','website','outbound','other'])[1 + i % 4],
        case when i % 10 = 0 then ${you}::uuid else null end, now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
      from generate_series(1, 10000) i`);
    psql(`insert into public.opportunities (organization_id, customer_id, title, stage, amount_cents, probability_percent, expected_close_date, lost_reason, closed_at, created_at, updated_at)
      select ${O}, c.id, 'Deal ' || lpad(i::text, 5, '0'), s.stage, (i * 137) % 5000000, 50, current_date + ((i % 400) - 100),
        case when s.stage = 'lost' then 'Seeded' else null end, case when s.stage in ('won','lost') then now() else null end,
        now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
      from generate_series(1, 10000) i
      join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i
      cross join lateral (select (array['new','qualified','proposal','negotiation','won','lost'])[1 + i % 6] as stage) s`);
    psql(`insert into public.tasks (organization_id, title, status, priority, due_date, assigned_to, customer_id, completed_at, created_at, updated_at)
      select ${O}, 'Task ' || lpad(i::text, 5, '0'), s.status, (array['low','medium','high','urgent'])[1 + i % 4],
        case when i % 10 = 0 then null else current_date + ((i % 730) - 365) end, case when i % 8 = 0 then ${you}::uuid else null end,
        c.id, case when s.status = 'done' then now() else null end, now() - ((i % 700) || ' days')::interval, now() - ((i % 300) || ' days')::interval
      from generate_series(1, 10000) i
      join (select id, row_number() over (order by display_name) rn from public.customers where organization_id = ${O}) c on c.rn = i
      cross join lateral (select (array['todo','in_progress','blocked','done'])[1 + i % 4] as status) s`);
  } finally {
    for (const t of ["customers", "opportunities", "tasks"])
      psql(`alter table public.${t} enable trigger user`);
  }
  psql("analyze public.customers; analyze public.opportunities; analyze public.tasks");
});

test("API: list, dashboard and reports latency, warm, p95 under 800 ms", async () => {
  test.setTimeout(300_000);
  const series: Array<[string, string]> = [
    ["customers, 100-row page", "/customers?limit=100"],
    ["customers, search", "/customers?limit=100&q=customer%2000"],
    [
      "customers, filter status=lead, sort name",
      "/customers?limit=100&status=lead&sort=display_name",
    ],
    ["opportunities, 100-row page", "/opportunities?limit=100"],
    [
      "opportunities, stage=proposal, sort amount",
      "/opportunities?limit=100&stage=proposal&sort=amount_cents&order=desc",
    ],
    ["tasks, 100-row page", "/tasks?limit=100"],
    ["tasks, overdue", "/tasks?limit=100&overdue=true"],
    ["dashboard", "/dashboard"],
    ["reports, 90 days", "/reports?range=90"],
  ];
  for (const [label, path] of series) {
    for (let i = 0; i < 3; i++) await api(owner, "GET", path, org); // warm-up, not counted
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      const res = await api(owner, "GET", path, org);
      await res.arrayBuffer();
      ms.push(performance.now() - t);
      expect(res.status, path).toBe(200);
    }
    const s = stats(ms);
    lines.push(`API  ${label.padEnd(44)} p50 ${s.p50} ms   p95 ${s.p95} ms   max ${s.max} ms`);
    expect(s.p95, `${label}: p95 ${s.p95} ms`).toBeLessThan(800);
  }
});

test("browser: the dashboard is usable in under 3 s warm; a 100-row list and a search stay responsive", async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  await signIn(context, owner);
  const dash: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    await page.goto("/app");
    await expect(page.getByRole("link", { name: /^Overdue tasks/ })).toBeVisible();
    await expect(page.getByText(/\d/, { exact: false }).first()).toBeVisible();
    if (i > 0) dash.push(performance.now() - t); // the first load warms the server's caches
  }
  const d = stats(dash);
  lines.push(
    `UI   dashboard, navigation to figures on screen (6 warm loads)   p50 ${d.p50} ms   max ${d.max} ms`,
  );
  expect(d.max, `dashboard max ${d.max} ms`).toBeLessThan(3000);

  const rows: number[] = [];
  const search: number[] = [];
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    await page.goto("/app/customers?limit=100&sort=display_name&order=asc");
    await expect(page.getByRole("row")).toHaveCount(101); // 100 rows and the header
    if (i > 0) rows.push(performance.now() - t);
    const box = page
      .getByRole("searchbox")
      .or(page.getByPlaceholder(/search/i))
      .first();
    await box.fill("");
    const s = performance.now();
    await box.fill("customer 0004");
    await expect(page.getByRole("link", { name: "Customer 00040" }).first()).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(101); // 100 matches again (00040..00049 and more)
    if (i > 0) search.push(performance.now() - s);
  }
  const r = stats(rows);
  const q = stats(search);
  lines.push(
    `UI   customers list at 100 rows, navigation to 100 rows (5 loads)   p50 ${r.p50} ms   max ${r.max} ms`,
  );
  lines.push(
    `UI   search typed into the 100-row list, until the new rows show (5)   p50 ${q.p50} ms   max ${q.max} ms`,
  );
  expect(r.max, `100-row list max ${r.max} ms`).toBeLessThan(3000);
});

test("database: default list queries on 10,000 rows, natural plan and index availability (EXPLAIN ANALYZE as the owner)", () => {
  const claims = JSON.stringify({ sub: owner.id, role: "authenticated" });
  const explain = (sql: string, seqscan: "on" | "off") =>
    psql(
      `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims}', true); set local enable_seqscan = ${seqscan}; explain (analyze, costs off) ${sql}; rollback;`,
    );
  const cases: Array<[string, string]> = [
    [
      "customers, newest first",
      `select * from public.customers where organization_id = '${org}' and archived_at is null order by updated_at desc limit 100`,
    ],
    [
      "opportunities, newest first",
      `select * from public.opportunities where organization_id = '${org}' order by updated_at desc limit 100`,
    ],
    [
      "tasks, by due date",
      `select * from public.tasks where organization_id = '${org}' and status <> 'done' order by due_date asc nulls last limit 100`,
    ],
  ];
  const node = (plan: string) =>
    /(Index (?:Only )?Scan using \w+|Seq Scan on \w+|Bitmap Index Scan on \w+)/.exec(plan)?.[1];
  const ms = (plan: string) => Number(/Execution Time: ([\d.]+) ms/.exec(plan)?.[1]);
  for (const [label, sql] of cases) {
    const natural = explain(sql, "on");
    const forced = explain(sql, "off");
    lines.push(
      `SQL  ${label.padEnd(28)} natural: ${node(natural)} ${ms(natural)} ms   |   seq scans off: ${node(forced)} ${ms(forced)} ms`,
    );
    // one workspace holds the whole table here, so a sequential scan is the planner's right choice; what matters is that
    // the natural plan is fast and that an index exists that the planner can use (it does when a scan is not an option)
    expect(ms(natural), `${label}: natural plan ${ms(natural)} ms`).toBeLessThan(250);
    expect(forced, `${label}: an index is usable`).toMatch(
      /Index (Only )?Scan using|Bitmap Index Scan on/,
    );
  }
});

test.afterAll(() => {
  console.log(
    `PERFORMANCE (10,000 customers, 10,000 opportunities, 10,000 tasks; local, warm)\n${lines.join("\n")}`,
  );
});
