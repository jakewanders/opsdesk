import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = "src/app";
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const source = (path: string) => readFileSync(path, "utf8");

describe("authenticated areas render per request", () => {
  it("the /app layout and the auth layout opt into request-time rendering with connection()", () => {
    for (const layout of ["src/app/app/layout.tsx", "src/app/(auth)/layout.tsx"]) {
      expect(source(layout), layout).toMatch(/await connection\(\)/);
    }
  });
  it("no page under /app or (auth) opts into static or cached rendering", () => {
    const offenders = files(join(ROOT, "app"))
      .concat(files(join(ROOT, "(auth)")))
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) =>
        /["']use cache["']|export const (revalidate|dynamic)\s*=\s*(?!0\b)|generateStaticParams|dynamic\s*=\s*["']force-static["']/.test(
          source(f),
        ),
      );
    expect(offenders).toEqual([]);
  });
  it("every API route handler is wrapped in withApi (private, no-store by construction)", () => {
    const api = files(join(ROOT, "api")).filter((f) => /route\.tsx?$/.test(f));
    const offenders = api.filter((f) => !/with(Org)?Api(<[^>]*>)?\(/.test(source(f)));
    expect(offenders).toEqual([]);
  });
});

describe("static pages contain no user data", () => {
  const pages = files(join(ROOT, "(marketing)")).filter((f) => /\.(ts|tsx)$/.test(f));
  it("there are marketing pages to check", () => {
    expect(pages.length).toBeGreaterThan(3);
  });
  it("marketing code never reads the session, cookies, headers or the user", () => {
    const offenders = pages.filter((f) =>
      /next\/headers|@\/lib\/supabase|getCurrentUser|resolveUser|cookies\(\)|headers\(\)|connection\(\)/.test(
        source(f),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
