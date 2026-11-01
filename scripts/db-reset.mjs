#!/usr/bin/env node
// `npm run db:reset`: rebuild the LOCAL Supabase database from migrations and seed.sql.
// Refuses to run when anything points at a non-local database.
import { spawnSync } from "node:child_process";
import { localDbViolations } from "./lib/assert-local-db.mjs";
import { withDockerPath } from "./lib/docker-path.mjs";

const args = process.argv.slice(2);
const problems = localDbViolations(process.env, args);

if (problems.length > 0) {
  console.error("db:reset refused. It only runs against the local Supabase stack:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const result = spawnSync("npx", ["supabase", "db", "reset", ...args], {
  stdio: "inherit",
  env: withDockerPath(),
});
process.exit(result.status ?? 1);
