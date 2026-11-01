import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasDbTests, hasE2eTests, hasIntegrationTests, planSteps } from "./steps.mjs";

function repo(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "steps-"));
  for (const file of files) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}

describe("planSteps", () => {
  it("check runs lint, format, typecheck, env guard, unit tests, build, then the bundle scan", () => {
    expect(planSteps("check", repo([]))).toEqual([
      "lint",
      "format:check",
      "typecheck",
      "check:env",
      "test:unit",
      "build",
      "check:bundle",
    ]);
  });

  it("skips db and e2e placeholders until their files exist", () => {
    const root = repo(["supabase/tests/README.md", "e2e/.gitkeep"]);
    expect(hasDbTests(root)).toBe(false);
    expect(hasE2eTests(root)).toBe(false);
    expect(planSteps("test", root)).toEqual(["test:unit"]);
  });

  it("adds test:db once a pgTAP file exists and test:e2e once a spec exists", () => {
    const root = repo(["supabase/tests/001_tenancy.sql", "e2e/demo/journey.spec.ts"]);
    expect(planSteps("test", root)).toEqual(["test:unit", "test:db", "test:e2e"]);
    expect(planSteps("check", root)).toContain("test:db");
    expect(planSteps("check", root)).toContain("test:e2e");
  });

  it("check builds before the integration tests, because the cache-leak test starts the production build", () => {
    const root = repo(["supabase/tests/a.sql", "src/x.integration.test.ts"]);
    expect(planSteps("check", root)).toEqual([
      "lint",
      "format:check",
      "typecheck",
      "check:env",
      "test:unit",
      "test:db",
      "build",
      "check:bundle",
      "test:integration",
    ]);
    // `npm test` has no build step; the cache-leak test builds on its own when none exists
    expect(planSteps("test", root)).toEqual(["test:unit", "test:db", "test:integration"]);
  });

  it("adds test:integration once a *.integration.test.ts exists under src", () => {
    const none = repo(["src/lib/a.test.ts"]);
    expect(hasIntegrationTests(none)).toBe(false);
    const some = repo(["src/lib/supabase/x.integration.test.ts"]);
    expect(hasIntegrationTests(some)).toBe(true);
    expect(planSteps("test", some)).toEqual(["test:unit", "test:integration"]);
  });
});
