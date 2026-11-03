import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIONS, MATRIX, ROLES } from "./matrix";
import { can } from "./can";
import { ENDPOINTS, expectedOutcome } from "./endpoints";

/** SIT-249: a route nobody classified fails here, so a new endpoint cannot ship without a decision about who may call it. */
const ROOT = "src/app/api/v1";
// The catch-all `[...path]` answers every path that is not an endpoint with the standard 404 envelope (SIT-275); it is not an endpoint.
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "[...path]") return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const implemented = new Set<string>();
for (const file of walk(ROOT).filter((f) => /route\.tsx?$/.test(f))) {
  const path =
    "/" +
    file
      .slice(ROOT.length + 1)
      .replace(/\/?route\.tsx?$/, "")
      .replace(/\[(\w+)\]/g, "{$1}");
  for (const m of readFileSync(file, "utf8").matchAll(
    /export const (GET|POST|PUT|PATCH|DELETE) =/g,
  )) {
    implemented.add(`${m[1]} ${path}`);
  }
}

/** The action each org route passes to `withOrgApi({ authorize })`, read from the route files. */
const authorizes = new Map<string, string | null>();
for (const file of walk(ROOT).filter((f) => /route\.tsx?$/.test(f))) {
  const path =
    "/" +
    file
      .slice(ROOT.length + 1)
      .replace(/\/?route\.tsx?$/, "")
      .replace(/\[(\w+)\]/g, "{$1}");
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(
    /export const (GET|POST|PUT|PATCH|DELETE) = (withOrgApi|withApi)/g,
  )) {
    const from = m.index!;
    const next = src.slice(from + 1).search(/export const (GET|POST|PUT|PATCH|DELETE) =/);
    const chunk = src.slice(from, next === -1 ? undefined : from + 1 + next);
    authorizes.set(
      `${m[1]} ${path}`,
      m[2] === "withOrgApi" ? (/authorize: "([a-z._]+)"/.exec(chunk)?.[1] ?? null) : "n/a",
    );
  }
}

describe("endpoint classification", () => {
  it("every workspace endpoint authorizes before it reads the request, with the action the table names", () => {
    for (const [key, rule] of Object.entries(ENDPOINTS)) {
      if (rule.who === "org")
        expect(
          authorizes.get(key),
          `${key} must pass authorize: "${rule.action}" to withOrgApi`,
        ).toBe(rule.action);
      else expect(authorizes.get(key), `${key} is not a workspace endpoint`).toBe("n/a");
    }
  });

  it("finds the implemented routes", () => {
    expect(implemented.size).toBeGreaterThanOrEqual(30);
  });

  it("every implemented endpoint is classified (a new endpoint fails here until it is)", () => {
    const missing = [...implemented].filter((e) => !(e in ENDPOINTS)).sort();
    expect(
      missing,
      `classify these in src/lib/permissions/endpoints.ts: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no classification outlives its route", () => {
    expect(
      Object.keys(ENDPOINTS)
        .filter((e) => !implemented.has(e))
        .sort(),
    ).toEqual([]);
  });

  it("every org endpoint names a real action", () => {
    for (const [key, rule] of Object.entries(ENDPOINTS)) {
      if (rule.who === "org") expect(ACTIONS, key).toContain(rule.action);
    }
  });

  it("no endpoint is open to a viewer or a guest for something the matrix reserves for writers, owners or admins", () => {
    for (const [key, rule] of Object.entries(ENDPOINTS)) {
      if (rule.who !== "org") continue;
      const isWrite = /^(POST|PATCH|PUT|DELETE) /.test(key);
      if (isWrite)
        expect(MATRIX[rule.action].roles.viewer.allow, `${key} must refuse viewers`).toBe(false);
    }
  });

  it("expectedOutcome follows the permission module for every role and workspace kind", () => {
    for (const [key, rule] of Object.entries(ENDPOINTS)) {
      if (rule.who !== "org") continue;
      for (const role of ROLES) {
        const real = expectedOutcome(rule, {
          signedIn: true,
          anonymous: false,
          membership: { role, kind: "real" },
        });
        expect(real, `${key} ${role}`).toBe(
          can(role, "real", rule.action).allowed ? "allowed" : "403",
        );
      }
      const guest = expectedOutcome(rule, {
        signedIn: true,
        anonymous: true,
        membership: { role: "owner", kind: "demo" },
      });
      expect(guest, `${key} guest`).toBe(
        can("owner", "demo", rule.action).allowed ? "allowed" : "403",
      );
      expect(expectedOutcome(rule, { signedIn: false }), key).toBe("401");
      expect(
        expectedOutcome(rule, { signedIn: true, anonymous: false, membership: null }),
        key,
      ).toBe("404");
    }
  });

  it("registered-only, guest-only and path-member endpoints classify callers correctly", () => {
    const registered = { signedIn: true as const, anonymous: false, membership: null };
    const guest = { signedIn: true as const, anonymous: true, membership: null };
    expect(expectedOutcome({ who: "registered" }, registered)).toBe("allowed");
    expect(expectedOutcome({ who: "registered" }, guest)).toBe("403");
    expect(expectedOutcome({ who: "guest-only" }, guest)).toBe("allowed");
    expect(expectedOutcome({ who: "guest-only" }, registered)).toBe("403");
    expect(expectedOutcome({ who: "member-of-path" }, registered)).toBe("404");
    expect(expectedOutcome({ who: "signed-in" }, guest)).toBe("allowed");
  });

  it("members.manage and members.owner_change keep the PRD shape: admins manage, only owners change owners, nobody in a demo", () => {
    expect(can("admin", "real", "members.manage").allowed).toBe(true);
    expect(can("member", "real", "members.manage").allowed).toBe(false);
    expect(can("admin", "real", "members.owner_change").allowed).toBe(false);
    expect(can("owner", "demo", "members.manage").allowed).toBe(false);
  });
});
