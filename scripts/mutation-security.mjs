import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDockerPath } from "./lib/docker-path.mjs";

/**
 * `npm run mutation:security` (P-04): weakens the database's protections one at a time, INSIDE the transaction of a copy of
 * supabase/tests/security-suite.test.sql (so nothing is ever committed to the local database), and requires the suite to FAIL for
 * every one. A survivor means a protection that no test would miss. Local database only.
 */
const FILE = "supabase/tests/security-suite.test.sql";
const MARK = "select tests.create_fixtures();";
const source = readFileSync(FILE, "utf8");
const dir = mkdtempSync(join(tmpdir(), "mutation-security-"));

const mutations = [
  [
    "a policy opened to everyone: customers_select_member using (true)",
    `drop policy customers_select_member on public.customers; create policy customers_select_member on public.customers for select to authenticated using (true);`,
  ],
  [
    "a write policy opened: opportunities_update_writer using/check (true)",
    `drop policy opportunities_update_writer on public.opportunities; create policy opportunities_update_writer on public.opportunities for update to authenticated using (true) with check (true);`,
  ],
  [
    "memberships readable across organizations",
    `drop policy memberships_select_same_org on public.memberships; create policy memberships_select_same_org on public.memberships for select to authenticated using (true);`,
  ],
  [
    "row level security switched off on tasks",
    `alter table public.tasks disable row level security;`,
  ],
  [
    "a policy for the wrong role: tasks_select_member to anon too",
    `drop policy tasks_select_member on public.tasks; create policy tasks_select_member on public.tasks for select to anon, authenticated using (private.is_member(organization_id));`,
  ],
  [
    "DELETE granted to authenticated on customers",
    `grant delete on public.customers to authenticated;`,
  ],
  ["anon granted SELECT on customers", `grant select on public.customers to anon;`],
  [
    "authenticated may write audit events",
    `grant insert on public.activity_events to authenticated;`,
  ],
  ["authenticated may update quote totals", `grant update on public.quotes to authenticated;`],
  ["authenticated may insert memberships", `grant insert on public.memberships to authenticated;`],
  [
    "the cleanup function callable by a signed-in user",
    `grant execute on function public.cleanup_purge_expired_demos(integer) to authenticated;`,
  ],
  [
    "a SECURITY DEFINER function without a pinned search_path",
    `alter function public.revise_quote(uuid) reset search_path;`,
  ],
  [
    "the composite foreign key between deals and customers dropped",
    `alter table public.opportunities drop constraint opportunities_customer_fkey;`,
  ],
  [
    "a view over a tenant table that bypasses RLS",
    `create view public.leaky_customers as select * from public.customers;`,
  ],
  [
    "a new public function callable by browser roles",
    `create function public.zz_unreviewed() returns int language sql security definer set search_path = '' as $$ select 1 $$; grant execute on function public.zz_unreviewed() to authenticated;`,
  ],
  [
    "a policy-less table opened (quote_sequences readable)",
    `grant select on public.quote_sequences to authenticated;`,
  ],
];

const env = withDockerPath();
function runSuite(file) {
  const r = spawnSync("npx", ["supabase", "test", "db", file], {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${r.stdout}\n${r.stderr}`;
  return {
    passed: r.status === 0 && /Result: PASS/.test(text),
    failures: (text.match(/^# Failed test \d+: "(.*)"$/gm) ?? []).length,
    text,
  };
}

const baseline = runSuite(FILE);
console.log(`baseline: ${baseline.passed ? "PASS" : "FAIL"}`);
if (!baseline.passed) process.exit(1);

const survivors = [];
mutations.forEach(([name, sql], i) => {
  const file = join(dir, `mutant-${i}.test.sql`);
  writeFileSync(file, source.replace(MARK, `${MARK}\n${sql}`));
  const r = runSuite(file);
  const caught = !r.passed;
  console.log(
    `${caught ? `caught (${r.failures} failed assertions)` : "SURVIVED"}`.padEnd(32),
    name,
  );
  if (!caught) survivors.push(name);
});
console.log(
  `\n${mutations.length} mutations, ${mutations.length - survivors.length} caught, ${survivors.length} survived`,
);
process.exit(survivors.length === 0 ? 0 : 1);
