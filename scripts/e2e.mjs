import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { withDockerPath } from "./lib/docker-path.mjs";
import { scanLogLines } from "./lib/log-scan.mjs";

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
// The run's output (the app server's JSON log lines are part of it) is kept in .e2e-output.log, and scanned for secrets,
// personal data, record contents, stack traces and database internals when the tests finish (SIT-275). A finding fails the run.

const LOG = ".e2e-output.log";
const sink = createWriteStream(LOG);
const code = await new Promise((resolve) => {
  const child = spawn("node_modules/.bin/playwright", ["test", ...process.argv.slice(2)], {
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    process.stdout.write(d);
    sink.write(d);
  });
  child.stderr.on("data", (d) => {
    process.stderr.write(d);
    sink.write(d);
  });
  child.on("close", (c) => resolve(c ?? 1));
});
sink.end();
await new Promise((r) => sink.on("finish", r));
const { jsonLines, findings } = scanLogLines(readFileSync(LOG, "utf8").split("\n"));
console.log(`\nLog scan: ${jsonLines} server log lines, ${findings.length} findings (${LOG}).`);
for (const f of findings.slice(0, 30)) console.log(`  line ${f.line}: ${f.rule} (${f.where})`);
process.exit(code !== 0 ? code : findings.length > 0 ? 1 : 0);
