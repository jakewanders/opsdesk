import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * [P-11] What the CI workflow may and may not do, checked from the file itself: it reads the repository only, it uses no
 * secret and no hosted Supabase or Netlify address, it pins every action to a version tag, it never runs untrusted fork code
 * with write access (`pull_request_target`), and the database job runs the pgTAP and integration suites on its own local stack.
 */
const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
const uncommented = workflow
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

describe("CI workflow guard", () => {
  it("has read-only permissions and no write scopes", () => {
    expect(uncommented).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(uncommented).not.toMatch(/:\s*write\b/);
  });
  it("reads no secret and names no production credential or hosted address", () => {
    expect(uncommented).not.toMatch(/\$\{\{\s*secrets\./);
    expect(uncommented).not.toMatch(/SUPABASE_SECRET_KEY|SERVICE_ROLE|NETLIFY_AUTH|VERCEL_TOKEN/);
    expect(uncommented).not.toMatch(/\.supabase\.co|sitelaunch\.dev|netlify\.app/);
  });
  it("never uses pull_request_target and pins every action to a version tag", () => {
    expect(uncommented).not.toMatch(/pull_request_target/);
    const uses = [...uncommented.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/@v\d+$/);
  });
  it("runs the database and API suites against a stack started inside the job", () => {
    const job = uncommented.slice(uncommented.indexOf("  database:"));
    for (const step of ["npm run db:start", "npm run test:db", "npm run test:integration"])
      expect(job, step).toContain(step);
    expect(job.indexOf("npm run db:start")).toBeLessThan(job.indexOf("npm run test:db"));
    expect(job).toContain("npm run db:stop");
  });
  it("keeps the lint, types, unit, build, env-name and bundle-secret gates in the verify job", () => {
    const verify = uncommented.slice(0, uncommented.indexOf("  database:"));
    for (const step of [
      "npm run lint",
      "npm run typecheck",
      "npm run check:env",
      "npm run test:unit",
      "npm run build",
      "npm run check:bundle",
    ])
      expect(verify, step).toContain(step);
  });
});
