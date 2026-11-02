import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** docs/openapi.yaml lists implemented routes only: a route without an entry (or an entry without a route) fails. */
const ROOT = "src/app/api/v1";
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const routes = new Map<string, Set<string>>();
for (const file of walk(ROOT).filter((f) => /route\.tsx?$/.test(f))) {
  const path =
    "/" +
    file
      .slice(ROOT.length + 1)
      .replace(/\/?route\.tsx?$/, "")
      .replace(/\[(\w+)\]/g, "{$1}");
  const methods = [
    ...readFileSync(file, "utf8").matchAll(/export const (GET|POST|PUT|PATCH|DELETE) =/g),
  ].map((m) => m[1].toLowerCase());
  routes.set(path.replace(/\/$/, "") || "/", new Set(methods));
}

const spec = readFileSync("docs/openapi.yaml", "utf8");
const documented = new Map<string, Set<string>>();
{
  let current: string | null = null;
  let inPaths = false;
  for (const line of spec.split("\n")) {
    if (/^paths:/.test(line)) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const path = /^ {2}(\/\S*):\s*$/.exec(line);
    if (path) {
      current = path[1];
      documented.set(current, new Set());
      continue;
    }
    const method = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (method && current) documented.get(current)!.add(method[1]);
  }
}

describe("docs/openapi.yaml", () => {
  it("finds the implemented routes and the documented paths", () => {
    expect(routes.size).toBeGreaterThanOrEqual(3);
    expect(documented.size).toBeGreaterThanOrEqual(3);
  });
  it("documents every implemented route and method, and nothing else", () => {
    const fmt = (m: Map<string, Set<string>>) =>
      [...m.entries()].map(([p, s]) => `${p} ${[...s].sort().join(",")}`).sort();
    expect(fmt(documented)).toEqual(fmt(routes));
  });
  it("declares the 200/201/401/403/404/422/429 responses the endpoints demonstrate", () => {
    for (const code of ["200", "201", "401", "403", "404", "422", "429"]) {
      expect(spec).toMatch(new RegExp(`['"]${code}['"]:`));
    }
  });
});
