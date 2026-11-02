import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDockerPath } from "./lib/docker-path.mjs";

/**
 * `npm run mutation:quotes` (SIT-230): removes, one at a time, every guard in the quote functions
 * (each `raise exception`, the row locks, the rounding constant, the line replacement) from the LOCAL database, runs the pgTAP
 * suite, and requires it to FAIL. The original functions are restored at the end and the suite must pass again.
 * Local database only (the container is `supabase_db_opsdesk`); it never touches a remote.
 */
const MIGRATION = "supabase/migrations/20261101003800_quote_functions.sql";
const env = withDockerPath();
const source = readFileSync(MIGRATION, "utf8");
const functions = source.slice(source.indexOf("create or replace function"));
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
  // A mutation counts as caught only when the quote-functions suite itself fails: a failure elsewhere says nothing about this guard.
  return {
    passed: r.status === 0,
    ownFailed:
      /quote-functions\.test\.sql[^\n]*(Wstat|Failed)/.test(text) ||
      /quote-functions[^\n]*Dubious/.test(text),
  };
};

/** Every place a guard lives, as [name, regex, replacement]; each regex occurrence is mutated on its own. */
const raises = [
  ...functions.matchAll(
    /raise exception using errcode = '(OD\d+)', message = (?:'[^']*(?:''[^']*)*'|pg_catalog\.format\('[^']*(?:''[^']*)*'(?:, [^;]*?)?\)), detail = '([A-Z_]+)';/g,
  ),
];
const mutations = [
  ...raises.map((m, i) => ({ name: `raise ${m[2]} (#${i + 1})`, text: m[0], from: m.index })),
  {
    name: "the sequence row lock (next_quote_number)",
    apply: (s) =>
      s.replace(
        "where s.organization_id = p_org_id for update;",
        "where s.organization_id = p_org_id;",
      ),
    only: "integration",
  },
  {
    name: "the quote row lock in update_draft_quote",
    apply: (s) =>
      s.replace(
        "select q.* into current_row from public.quotes q where q.id = p_id for update;\n  if not found or not private.is_member(current_row.organization_id) then\n    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';\n  end if;\n  perform private.require_quote_writer(current_row.organization_id);\n  if current_row.status <> 'draft'",
        "select q.* into current_row from public.quotes q where q.id = p_id;\n  if not found or not private.is_member(current_row.organization_id) then\n    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';\n  end if;\n  perform private.require_quote_writer(current_row.organization_id);\n  if current_row.status <> 'draft'",
      ),
    only: "integration",
  },
  {
    name: "the quote row lock in transition_quote",
    apply: (s) =>
      s.replace(
        "select q.* into current_row from public.quotes q where q.id = p_id for update;\n  if not found or not private.is_member(current_row.organization_id) then\n    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';\n  end if;\n  perform private.require_quote_writer(current_row.organization_id);\n  if p_to_status is null",
        "select q.* into current_row from public.quotes q where q.id = p_id;\n  if not found or not private.is_member(current_row.organization_id) then\n    raise exception using errcode = 'OD404', message = 'That quote was not found.', detail = 'QUOTE_NOT_FOUND';\n  end if;\n  perform private.require_quote_writer(current_row.organization_id);\n  if p_to_status is null",
      ),
    only: "integration",
  },
  {
    name: "the source row lock in revise_quote",
    apply: (s) =>
      s.replace(
        "select q.* into source from public.quotes q where q.id = p_id for update;",
        "select q.* into source from public.quotes q where q.id = p_id;",
      ),
    only: "integration",
  },
  {
    name: "half-up rounding (+5000 becomes +4999)",
    apply: (s) =>
      s.replace(
        "pg_catalog.div(taxable * p_tax_rate_bps + 5000, 10000)",
        "pg_catalog.div(taxable * p_tax_rate_bps + 4999, 10000)",
      ),
    only: "integration",
  },
  {
    name: "tax computed on the subtotal, not the taxable amount",
    apply: (s) =>
      s.replace(
        "pg_catalog.div(taxable * p_tax_rate_bps + 5000, 10000)",
        "pg_catalog.div(sub * p_tax_rate_bps + 5000, 10000)",
      ),
  },
  {
    name: "old lines kept on update (the delete is removed)",
    apply: (s) => s.replace("delete from public.quote_items i where i.quote_id = p_id;", ""),
  },
  {
    name: "the version is not incremented on update",
    apply: (s) => s.replace("notes = p_notes, version = q.version + 1", "notes = p_notes"),
  },
  {
    name: "the version is not incremented on transition",
    apply: (s) =>
      s.replace("set status = p_to_status, version = q.version + 1", "set status = p_to_status"),
  },
  {
    name: "the writer helper no longer checks the role",
    apply: (s) =>
      s.replace(
        "if not private.has_role(p_org_id, array['owner', 'admin', 'member']) then",
        "if false then",
      ),
  },
  {
    name: "the writer helper no longer checks membership",
    apply: (s) =>
      s.replace(
        "if p_org_id is null or not private.is_member(p_org_id) then",
        "if p_org_id is null then",
      ),
  },
  {
    name: "the writer helper no longer checks demo expiry",
    apply: (s) => s.replace("if not private.org_is_writable(p_org_id) then", "if false then"),
  },
  {
    name: "revise copies no lines",
    apply: (s) =>
      s.replace(
        "from public.quote_items i where i.quote_id = source.id;",
        "from public.quote_items i where false;",
      ),
  },
];

const only = process.env.MUTATION_FILTER ? new RegExp(process.env.MUTATION_FILTER) : null;
/**
 * Mutants that cannot change behaviour because another, independent guard answers the same way (here: update_draft_quote's own QUOTE_LOCKED check, which the table's state guard repeats with the same code and message, so the outward result is identical).
 */
const EQUIVALENT = [/^raise QUOTE_LOCKED \(#24\)$/];
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
        "src/lib/domain/quote-functions.integration.test.ts",
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
