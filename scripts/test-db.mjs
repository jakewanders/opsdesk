#!/usr/bin/env node
// `npm run test:db`: run the pgTAP tests in supabase/tests against the LOCAL database.
// Needs `npm run db:start` first. Refuses to run against anything that is not local.
import { spawnSync } from "node:child_process";
import { localDbViolations } from "./lib/assert-local-db.mjs";
import { withDockerPath } from "./lib/docker-path.mjs";

const problems = localDbViolations(process.env, process.argv.slice(2));
if (problems.length > 0) {
  console.error("test:db refused. It only runs against the local Supabase stack:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const result = spawnSync("npx", ["supabase", "test", "db"], {
  stdio: "inherit",
  env: withDockerPath(),
});
if (result.status !== 0) {
  console.error(
    "\ntest:db failed. If the database is not running, start it with `npm run db:start`.",
  );
}
process.exit(result.status ?? 1);
