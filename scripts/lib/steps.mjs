// Which steps `npm run check` and `npm test` run. Optional suites join automatically once
// their files exist, so a placeholder script never hides a real failure.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function hasFile(dir, test) {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (hasFile(path, test)) return true;
    } else if (test(entry)) {
      return true;
    }
  }
  return false;
}

/** pgTAP tests exist once a .sql file is in supabase/tests. */
export const hasDbTests = (root = ".") =>
  hasFile(join(root, "supabase/tests"), (f) => f.endsWith(".sql"));
/** Integration tests (need the local Supabase stack) exist once a *.integration.test.ts is in src. */
export const hasIntegrationTests = (root = ".") =>
  hasFile(join(root, "src"), (f) => f.endsWith(".integration.test.ts"));
/** Playwright specs exist once a *.spec.ts is in e2e. */
export const hasE2eTests = (root = ".") =>
  hasFile(join(root, "e2e"), (f) => /\.spec\.[cm]?[jt]s$/.test(f));

/**
 * @param {"check" | "test"} mode
 * @returns {string[]} npm script names, in order
 */
export function planSteps(mode, root = ".") {
  const tests = ["test:unit"];
  if (hasDbTests(root)) tests.push("test:db");
  if (hasIntegrationTests(root)) tests.push("test:integration");
  if (hasE2eTests(root)) tests.push("test:e2e");
  if (mode === "test") return tests;
  // The integration tests start the production build (cache-leak test), so `build` comes first.
  const beforeBuild = tests.filter((t) => t !== "test:integration" && t !== "test:e2e");
  const afterBuild = tests.filter((t) => t === "test:integration" || t === "test:e2e");
  return [
    "lint",
    "format:check",
    "typecheck",
    "check:env",
    ...beforeBuild,
    "build",
    "check:bundle",
    ...afterBuild,
  ];
}
