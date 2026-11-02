import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDockerPath } from "./lib/docker-path.mjs";

/**
 * `npm run mutation:membership` (SIT-265): removes, one at a time, every guard in the membership and invitation functions
 * (each `raise exception`, each redemption refusal, the row lock, the token hashing) from the LOCAL database, runs the pgTAP
 * suite, and requires it to FAIL. The original functions are restored at the end and the suite must pass again.
 * Local database only (the container is `supabase_db_opsdesk`); it never touches a remote.
 */
const MIGRATION = "supabase/migrations/20261101003300_membership_functions.sql";
const PREVIEW = "supabase/migrations/20261101003500_preview_invitation.sql";
const env = withDockerPath();
const source = readFileSync(MIGRATION, "utf8");
const functions = source.slice(source.indexOf("create or replace function"));
const preview = readFileSync(PREVIEW, "utf8");
const dir = mkdtempSync(join(tmpdir(), "mutation-"));

function load(sql) {
  const file = join(dir, "load.sql");
  writeFileSync(file, sql);
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_opsdesk",
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      env,
      input: readFileSync(file),
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
}
const suite = () => {
  const r = spawnSync("node", ["scripts/test-db.mjs"], {
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${r.stdout}\n${r.stderr}`;
  // A mutation counts as caught only when the membership suite itself fails: a failure elsewhere says nothing about this guard.
  return {
    passed: r.status === 0,
    ownFailed:
      /membership-functions\.test\.sql[^\n]*(Wstat|Failed)/.test(text) ||
      /membership-functions[^\n]*Dubious/.test(text),
  };
};

/** Every place a guard lives, as [name, regex, replacement]; each regex occurrence is mutated on its own. */
const raises = [
  ...functions.matchAll(
    /raise exception using errcode = '(OD\d+)', message = '[^']*(?:''[^']*)*', detail = '([A-Z_]+)';/g,
  ),
];
const refusals = [
  ...functions.matchAll(
    /return pg_catalog\.jsonb_build_object\('ok', false, 'reason', '([a-z_]+)'\);/g,
  ),
];
const mutations = [
  ...raises.map((m, i) => ({
    name: `raise ${m[2]} (#${i + 1})`,
    apply: (s) => s.replace(m[0], "null;"),
    from: m.index,
    text: m[0],
  })),
  ...refusals.map((m, i) => ({
    name: `redeem refusal "${m[1]}" (#${i + 1})`,
    apply: (s) => s.replace(m[0], "null;"),
    from: m.index,
    text: m[0],
  })),
  {
    name: "row lock on organizations (change_membership)",
    apply: (s) => s.replace("o.id = p_org_id for update;", "o.id = p_org_id;"),
    only: "integration",
  },
  {
    name: "token stored in plaintext instead of its hash",
    apply: (s) =>
      s.replace(
        "pg_catalog.encode(sha256(pg_catalog.convert_to(token, 'utf8')), 'hex'), uid)",
        "token, uid)",
      ),
  },
  {
    name: "admin may grant owner (OWNER_GRANT condition)",
    apply: (s) => s.replace("and p_new_role = 'owner' then", "and false then"),
  },
  {
    name: "owner invitable (role list)",
    apply: (s) =>
      s.replace(
        "p_role not in ('admin', 'member', 'viewer')",
        "p_role not in ('owner', 'admin', 'member', 'viewer')",
      ),
  },
];

const only = process.env.MUTATION_FILTER ? new RegExp(process.env.MUTATION_FILTER) : null;
/**
 * Mutants that cannot change behaviour because another, independent guard answers the same way. Every "invalid" refusal is one of
 * several layers (token shape, hash lookup, workspace must be real); removing a single layer leaves the others to refuse the same
 * request, and the workspace-is-real check is unreachable anyway because a trigger forbids invitations to demo workspaces.
 */
const EQUIVALENT = [
  /^redeem refusal "invalid" \(#(2|3|9)\)$/,
  /^preview refusal "invalid" \(#\d+\)$/,
];
const results = [];
for (const mutation of mutations.filter((m) => !only || only.test(m.name))) {
  // mutate by occurrence: the text is unique per index, so replace that exact slice
  let mutated;
  if (mutation.text !== undefined) {
    mutated =
      functions.slice(0, mutation.from) +
      "null;" +
      functions.slice(mutation.from + mutation.text.length);
  } else {
    mutated = mutation.apply(functions);
    if (mutated === functions) {
      results.push({ name: mutation.name, status: "NOT APPLIED" });
      continue;
    }
  }
  load(mutated);
  if (mutation.only === "integration") {
    const r = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "--config",
        "vitest.integration.config.mts",
        "src/test/membership-concurrency.integration.test.ts",
      ],
      { env, encoding: "utf8" },
    );
    results.push({
      name: mutation.name,
      status: /failed/.test(r.stdout + r.stderr) ? "caught (concurrency test)" : "SURVIVED",
    });
  } else {
    results.push({ name: mutation.name, status: suite().ownFailed ? "caught" : "SURVIVED" });
  }
  load(functions); // restore before the next one
  console.log(`${results.at(-1).status.padEnd(26)} ${mutation.name}`);
}
// the preview function has its own guards
const previewFn = preview.slice(preview.indexOf("create or replace function"));
for (const m of only && !only.test("preview")
  ? []
  : [
      ...previewFn.matchAll(
        /return pg_catalog\.jsonb_build_object\('ok', false, 'reason', '([a-z_]+)'[^;]*\);/g,
      ),
    ]) {
  load(previewFn.slice(0, m.index) + "null;" + previewFn.slice(m.index + m[0].length));
  const r = suite().ownFailed ? "caught" : "SURVIVED";
  results.push({ name: `preview refusal "${m[1]}" (#${results.length})`, status: r });
  console.log(`${r.padEnd(26)} preview refusal "${m[1]}"`);
  load(previewFn);
}
load(functions);
// Leave the local database freshly reset (the migrations restore every function), then require the whole suite to pass on it.
if (!only) execFileSync("node", ["scripts/db-reset.mjs"], { env, stdio: "ignore" });
const back = suite();
const equivalent = results.filter(
  (r) => r.status === "SURVIVED" && EQUIVALENT.some((re) => re.test(r.name)),
);
const survived = results.filter(
  (r) =>
    (r.status === "SURVIVED" && !EQUIVALENT.some((re) => re.test(r.name))) ||
    r.status === "NOT APPLIED",
);
console.log(
  `\n${results.length} mutations, ${results.length - survived.length - equivalent.length} caught, ${equivalent.length} equivalent (another guard answers identically), ${survived.length} survived or not applied; restored suite: ${back.passed ? "PASS" : "FAIL"}`,
);
process.exit(survived.length === 0 && back.passed ? 0 : 1);
