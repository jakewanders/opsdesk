// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync("supabase/config.toml", "utf8");

/** Cloudflare's published dummy secrets (always pass, always block, token already spent). */
const DUMMY_SECRETS = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

function section(name: string): string {
  const start = config.indexOf(`\n[${name}]`);
  expect(start, `[${name}] section`).toBeGreaterThan(-1);
  const rest = config.slice(start + 1);
  const next = rest.slice(1).search(/\n\[/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("supabase/config.toml (SIT-168)", () => {
  it("enables anonymous sign-ins", () => {
    expect(section("auth")).toMatch(/^enable_anonymous_sign_ins\s*=\s*true/m);
  });

  it("enables CAPTCHA with the Turnstile provider", () => {
    const block = section("auth.captcha");
    expect(block).toMatch(/^enabled\s*=\s*true/m);
    expect(block).toMatch(/^provider\s*=\s*"turnstile"/m);
  });

  it("holds only a Cloudflare dummy secret, never a real one", () => {
    const secret = /^secret\s*=\s*"([^"]*)"/m.exec(section("auth.captcha"))?.[1];
    expect(DUMMY_SECRETS).toContain(secret);
  });

  it("keeps a rate limit on anonymous sign-ins", () => {
    expect(section("auth.rate_limit")).toMatch(/^anonymous_users\s*=\s*\d+/m);
  });
});

describe("no real Turnstile secret anywhere in the repository", () => {
  // Real Turnstile secret keys start with "0x4"; site keys start with "0x4" as well. Dummy keys
  // start with 1x, 2x, or 3x.
  const REAL_KEY = /\b0x4[A-Za-z0-9_-]{18,}\b/;
  const SKIP = new Set(["node_modules", ".next", ".git", "coverage"]);

  function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) yield* files(path);
      else if (/\.(ts|tsx|mts|mjs|json|toml|ya?ml|md|sql|example)$|^\.env/.test(entry)) yield path;
    }
  }

  it("finds none in tracked text files", () => {
    const hits: string[] = [];
    for (const root of [
      "src",
      "supabase",
      "docs",
      "scripts",
      ".env.example",
      "README.md",
      "netlify.toml",
    ]) {
      const paths = statSync(root).isDirectory() ? [...files(root)] : [root];
      for (const path of paths) {
        if (path.endsWith("captcha-config.test.ts")) continue;
        if (REAL_KEY.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    }
    expect(hits).toEqual([]);
  });
});
