#!/usr/bin/env node
// Route smoke test against a RUNNING server: `npm run smoke:routes [-- http://localhost:3000]`.
// Every PRD 3.3 route must resolve (not 404; redirects count), /app/* must be no-store, and
// P2 routes must 404 while their flag is off. Pass --flags-on when the server runs with the
// P2 flags enabled.
import { readFileSync } from "node:fs";

const base = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const flagsOn = process.argv.includes("--flags-on");

// Parse src/lib/routes.ts so this script and the unit test share one route list.
const source = readFileSync("src/lib/routes.ts", "utf8");
const routes = [
  ...source.matchAll(
    /\{ path: "([^"]+)", group: "(public|app)"(?:, sample: `([^`]+)`)?(?:, flag: "(\w+)")? \}/g,
  ),
].map((m) => ({
  path: m[1],
  group: m[2],
  url: (m[3] ?? m[1]).replace("${ID}", "00000000-0000-0000-0000-000000000000"),
  flag: m[4],
}));
if (routes.length < 20) {
  console.error(`Parsed only ${routes.length} routes from src/lib/routes.ts; check the pattern.`);
  process.exit(2);
}

let failures = 0;
for (const route of routes) {
  const res = await fetch(base + route.url, { redirect: "manual" });
  const cache = res.headers.get("cache-control") ?? "";
  const expect404 = route.flag !== undefined && !flagsOn;
  const problems = [];
  if (expect404 && res.status !== 404) problems.push(`expected 404, got ${res.status}`);
  if (!expect404 && res.status === 404) problems.push("unexpected 404");
  if (!expect404 && res.status >= 500) problems.push(`server error ${res.status}`);
  // Redirects carry no content, so only responses with a body need a cache policy.
  const isRedirect = res.status >= 300 && res.status < 400;
  if (route.group === "app" && !expect404 && !isRedirect && !/no-store|private/.test(cache)) {
    problems.push(`cache-control "${cache}" is not no-store/private`);
  }
  if (problems.length) failures += 1;
  console.log(
    `${problems.length ? "FAIL" : "ok  "} ${String(res.status).padEnd(3)} ${route.url}${problems.length ? "  <- " + problems.join("; ") : ""}`,
  );
}
console.log(
  failures ? `\n${failures} route(s) failed` : `\nAll ${routes.length} routes behaved as expected`,
);
process.exit(failures ? 1 : 0);
