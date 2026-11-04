// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// jsdom renders everything as a client component, so it cannot catch a server component that calls one of these hooks.
// The production build can (and did: every quote page crashed), so this keeps it from reaching a browser test.
const HOOKS = /\b(useIsFresh|useCountUp|usePrefersReducedMotion)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("motion hooks", () => {
  it("are only called from files marked 'use client'", () => {
    const offenders = sources(join(process.cwd(), "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        HOOKS.test(text) && !/^\s*(\/\/.*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });
});
