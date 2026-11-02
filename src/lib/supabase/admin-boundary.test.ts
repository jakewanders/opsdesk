// @vitest-environment node
import { ESLint } from "eslint";
import { describe, expect, it, vi } from "vitest";

const IMPORT =
  'import { createAdminClient } from "@/lib/supabase/admin";\nexport const c = createAdminClient;\n';

describe("the admin Supabase client import boundary (lint)", () => {
  const eslint = new ESLint({ cwd: process.cwd() });
  async function ruleIds(filePath: string, code = IMPORT) {
    const [result] = await eslint.lintText(code, { filePath });
    return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
  }

  it.each([
    "src/components/shared/x.tsx",
    "src/app/app/customers/page.tsx",
    "src/app/api/v1/customers/route.ts",
    "src/features/customers/service.ts",
    "src/lib/supabase/server.ts",
  ])("forbids importing it from %s", async (path) => {
    expect(await ruleIds(path)).toContain("no-restricted-imports");
  });

  it("forbids a relative import too", async () => {
    const code =
      'import { createAdminClient } from "../../lib/supabase/admin";\nexport const c = createAdminClient;\n';
    expect(await ruleIds("src/features/customers/service.ts", code)).toContain(
      "no-restricted-imports",
    );
  });

  it.each([
    "src/features/demo/cleanup/purge.ts",
    "src/lib/cleanup/run.ts",
    "src/app/api/v1/demo/bootstrap/route.ts",
    "netlify/functions/cleanup-demo.mts",
    "scripts/demo-cleanup.mjs",
  ])("allows it in %s", async (path) => {
    expect(await ruleIds(path)).not.toContain("no-restricted-imports");
  });
});

describe("createAdminClient", () => {
  it("refuses to build a client without SUPABASE_SECRET_KEY", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const { createAdminClient } = await import("./admin");
    expect(() => createAdminClient()).toThrow(/SUPABASE_SECRET_KEY is not configured/);
    vi.unstubAllEnvs();
  });

  it("builds a non-persisting client when the secret is configured", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test_value");
    const { createAdminClient } = await import("./admin");
    const client = createAdminClient();
    expect(typeof client.from).toBe("function");
    vi.unstubAllEnvs();
  });
});
