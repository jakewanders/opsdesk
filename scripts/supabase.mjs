#!/usr/bin/env node
// `node scripts/supabase.mjs <args>`: run the pinned Supabase CLI with Docker on PATH.
import { spawnSync } from "node:child_process";
import { withDockerPath } from "./lib/docker-path.mjs";

const result = spawnSync("npx", ["supabase", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: withDockerPath(),
});
process.exit(result.status ?? 1);
