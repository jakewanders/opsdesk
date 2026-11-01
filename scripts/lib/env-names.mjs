// Naming guard: browser-exposed variables (NEXT_PUBLIC_*) must never look like secrets.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const FORBIDDEN_FRAGMENTS = ["SECRET", "SERVICE", "WEBHOOK"];
const NAME_PATTERN = /NEXT_PUBLIC_[A-Z0-9_]+/g;

/** @param {string} text @returns {string[]} unique NEXT_PUBLIC_* names in text */
export function publicNamesIn(text) {
  return [...new Set(text.match(NAME_PATTERN) ?? [])];
}

/** @param {Iterable<string>} names @returns {string[]} violation messages */
export function nameViolations(names) {
  const out = [];
  for (const name of names) {
    const hit = FORBIDDEN_FRAGMENTS.find((fragment) => name.includes(fragment));
    if (hit)
      out.push(`${name} contains "${hit}"; browser-exposed variables must not look like secrets`);
  }
  return out;
}

function* walk(path) {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isFile()) {
    yield path;
    return;
  }
  for (const entry of readdirSync(path)) {
    if (entry === "node_modules" || entry === ".next") continue;
    yield* walk(join(path, entry));
  }
}

const SCANNED_FILE = /\.(ts|tsx|mts|mjs|js|json|toml|ya?ml|md)$|(^|\/)\.env[^/]*$/;
const TEST_FILE = /\.test\.[a-z]+$/;

/** Scan the given roots (files or directories) plus the process environment. */
export function checkEnvNames(roots, env = {}) {
  const names = new Set(Object.keys(env).filter((key) => key.startsWith("NEXT_PUBLIC_")));
  for (const root of roots) {
    for (const file of walk(root)) {
      if (TEST_FILE.test(file) || !SCANNED_FILE.test(file)) continue;
      for (const name of publicNamesIn(readFileSync(file, "utf8"))) names.add(name);
    }
  }
  return nameViolations(names);
}
