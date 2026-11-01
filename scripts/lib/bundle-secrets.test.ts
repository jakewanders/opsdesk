import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanClientBundle } from "./bundle-secrets.mjs";

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bundle-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, "chunks"), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("scanClientBundle", () => {
  it("passes a clean bundle", () => {
    const dir = bundle({ "chunks/a.js": "console.log('hello', process.env.NEXT_PUBLIC_APP_URL)" });
    expect(scanClientBundle(dir, { SUPABASE_SECRET_KEY: "s3cr3t-value-123" })).toEqual({
      scanned: 1,
      findings: [],
    });
  });

  it("finds a leaked secret value", () => {
    const dir = bundle({ "chunks/a.js": "const k='s3cr3t-value-123'" });
    const { findings } = scanClientBundle(dir, { SUPABASE_SECRET_KEY: "s3cr3t-value-123" });
    expect(findings).toEqual([expect.stringContaining("value of SUPABASE_SECRET_KEY")]);
  });

  it("finds a server-only variable name", () => {
    const dir = bundle({ "chunks/a.js": "process.env.STRIPE_WEBHOOK_SECRET" });
    expect(scanClientBundle(dir, {}).findings).toEqual([
      expect.stringContaining("STRIPE_WEBHOOK_SECRET"),
    ]);
  });
});
