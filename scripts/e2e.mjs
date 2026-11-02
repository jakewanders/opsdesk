import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { withDockerPath } from "./lib/docker-path.mjs";

/**
 * `npm run test:e2e` (SIT-251): builds the app WITH the local Supabase settings (the browser bundle bakes in the
 * NEXT_PUBLIC_* values at build time) and runs the Playwright suite against `next start`. Refuses any non-local Supabase.
 * Needs `npm run db:start`. Pass extra arguments through, for example `npm run test:e2e -- --headed`.
 */
const json = execFileSync("npx", ["supabase", "status", "-o", "json"], {
  env: withDockerPath(),
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const status = JSON.parse(json.slice(json.indexOf("{")));
const host = new URL(status.API_URL).hostname;
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error(`Refusing to run end-to-end tests against non-local host "${host}".`);
  process.exit(1);
}
const env = {
  ...process.env,
  NEXT_DIST_DIR: ".next-e2e",
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
  NEXT_PUBLIC_APP_URL: "http://localhost:3111",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
};
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit", env }).status ?? 1;
// a clean build directory: a cached build once served stale CSS to the browser tests
rmSync(".next-e2e", { recursive: true, force: true });
if (run("node_modules/.bin/next", ["build"]) !== 0) process.exit(1);
process.exit(run("node_modules/.bin/playwright", ["test", ...process.argv.slice(2)]));
