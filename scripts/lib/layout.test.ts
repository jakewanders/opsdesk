import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

// PRD 10 directory layout. Files that later issues create (.github/workflows/ci.yml,
// netlify.toml, docs/SECURITY.md, ...) are not required here.
const DIRS = [
  "src/app/(marketing)",
  "src/app/(auth)",
  "src/app/app",
  "src/app/api/v1",
  "src/components/ui",
  "src/components/layout",
  "src/components/shared",
  "src/features/customers",
  "src/features/opportunities",
  "src/features/tasks",
  "src/features/quotes",
  "src/features/reports",
  "src/features/demo",
  "src/lib/supabase",
  "src/lib/auth",
  "src/lib/permissions",
  "src/lib/api",
  "src/lib/domain",
  "src/lib/validation",
  "src/lib/money",
  "src/lib/logger",
  "supabase/migrations",
  "supabase/tests",
  "netlify/functions",
  "e2e",
  "docs",
];

const FILES = [
  "supabase/seed.sql",
  ".env.example",
  "README.md",
  "docs/ARCHITECTURE.md",
  "docs/DECISIONS.md",
];

describe("repository layout (PRD 10)", () => {
  it.each(DIRS)("has %s", (dir) => {
    expect(existsSync(dir)).toBe(true);
  });
  it.each(FILES)("has %s", (file) => {
    expect(existsSync(file)).toBe(true);
  });
});
