import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";
import { B, type Ids } from "@/test/api-requests";
import { ENDPOINTS, expectedOutcome, type Caller, type EndpointRule } from "./endpoints";

/**
 * SIT-249: every classified endpoint, called as every kind of caller against the real server and the real database, and the
 * status compared with what the permission module says. Generated from `ENDPOINTS` (which a new route cannot skip: see
 * `endpoints.test.ts`) and from `can()`. A route with no request builder below fails too, so a new endpoint needs both.
 *
 * "allowed" means authorization let the request through: it may still answer 200, 201, 204, 404 for a missing record, 409 or
 * 422. A refused request must be exactly 403 (a role or demo restriction), 404 `ORG_NOT_FOUND` (not a member) or 401.
 */
const server = new RealServer();
let owner: Actor, admin: Actor, member: Actor, viewer: Actor, outsider: Actor, guest: Actor;
let orgA = "";
let demoOrg = "";
let idsA: Ids, idsDemo: Ids;

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

async function seed(actor: Actor, org: string): Promise<Ids> {
  const h = { "X-Organization-Id": org };
  const post = async (path: string, json: unknown) =>
    (await (await server.request(`/api/v1${path}`, actor, { json, headers: h })).json()).data
      .id as string;
  const customer = await post("/customers", { displayName: "Matrix seed customer" });
  const opportunity = await post("/opportunities", {
    customerId: customer,
    title: "Matrix seed deal",
  });
  const task = await post("/tasks", { title: "Matrix seed task" });
  const quote = await post("/quotes", {
    customerId: customer,
    title: "Matrix seed quote",
    items: [{ description: "Seed line", quantity: 1, unitPriceCents: 100 }],
  });
  return { customer, opportunity, task, quote };
}

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, guest] = await Promise.all([
    server.member("mx-owner"),
    server.member("mx-admin"),
    server.member("mx-member"),
    server.member("mx-viewer"),
    server.member("mx-outsider"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Matrix Co");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demoOrg = (await boot.json()).data.organizationId;
  idsA = await seed(owner, orgA);
  idsDemo = await seed(guest, demoOrg);
}, 400_000);

afterAll(() => server.stop());

type Case = { name: string; actor: Actor | null; org: string; ids: Ids; caller: Caller };
const registered = (m: { role: string; kind: string } | null): Caller => ({
  signedIn: true,
  anonymous: false,
  membership: m,
});
const cases = (): Case[] => [
  { name: "signed out", actor: null, org: orgA, ids: idsA, caller: { signedIn: false } },
  {
    name: "owner",
    actor: owner,
    org: orgA,
    ids: idsA,
    caller: registered({ role: "owner", kind: "real" }),
  },
  {
    name: "admin",
    actor: admin,
    org: orgA,
    ids: idsA,
    caller: registered({ role: "admin", kind: "real" }),
  },
  {
    name: "member",
    actor: member,
    org: orgA,
    ids: idsA,
    caller: registered({ role: "member", kind: "real" }),
  },
  {
    name: "viewer",
    actor: viewer,
    org: orgA,
    ids: idsA,
    caller: registered({ role: "viewer", kind: "real" }),
  },
  { name: "non-member", actor: outsider, org: orgA, ids: idsA, caller: registered(null) },
  {
    name: "demo guest (own demo)",
    actor: guest,
    org: demoOrg,
    ids: idsDemo,
    caller: { signedIn: true, anonymous: true, membership: { role: "owner", kind: "demo" } },
  },
  {
    name: "demo guest (a real workspace)",
    actor: guest,
    org: orgA,
    ids: idsA,
    caller: { signedIn: true, anonymous: true, membership: null },
  },
];

/** Non-membership callers of workspace-less endpoints: the header is irrelevant, so only send it where the endpoint reads it. */
function usesHeader(rule: EndpointRule) {
  return rule.who === "org";
}

describe("endpoint x caller matrix (generated from the permission module)", () => {
  it("has a request builder for every classified endpoint", () => {
    expect(
      Object.keys(ENDPOINTS)
        .filter((k) => !(k in B))
        .sort(),
    ).toEqual([]);
    expect(
      Object.keys(B)
        .filter((k) => !(k in ENDPOINTS))
        .sort(),
    ).toEqual([]);
  });

  for (const [key, rule] of Object.entries(ENDPOINTS)) {
    it(`${key}`, async () => {
      const results: string[] = [];
      for (const c of cases()) {
        // a registered caller of a path-member endpoint names a workspace they may or may not belong to
        const req = B[key]({ org: c.org, ids: c.ids });
        const res = await server.request(`/api/v1${req.path}`, c.actor, {
          method: req.method,
          json: req.json,
          headers: usesHeader(rule) ? { "X-Organization-Id": c.org } : undefined,
        });
        const body = await res
          .clone()
          .json()
          .catch(() => ({}));
        const errCode = (body as { error?: { code?: string } }).error?.code;
        const want = expectedOutcome(rule, c.caller);
        const got =
          res.status === 401
            ? "401"
            : res.status === 403
              ? "403"
              : res.status === 404 &&
                  (errCode === "ORG_NOT_FOUND" ||
                    (rule.who === "member-of-path" && !c.caller.signedIn === false))
                ? "404"
                : "allowed";
        // a path-member endpoint answers a plain 404 for a stranger
        const normalized = rule.who === "member-of-path" && res.status === 404 ? "404" : got;
        if (normalized !== want)
          results.push(
            `${c.name}: wanted ${want}, got HTTP ${res.status} ${errCode ?? ""} ${JSON.stringify((body as { error?: { fieldErrors?: unknown } }).error?.fieldErrors ?? "")}`,
          );
      }
      expect(results, key).toEqual([]);
    });
  }

  // Authorization comes before validation: a refused caller learns nothing about the body, so even an empty or invalid one is
  // a 403 (never a 422 that would show which fields the endpoint reads).
  it("a refused caller gets 403 even when the body is invalid", async () => {
    const problems: string[] = [];
    for (const [key, rule] of Object.entries(ENDPOINTS)) {
      if (rule.who !== "org" || !B[key]({ org: orgA, ids: idsA }).json) continue;
      for (const c of cases().filter(
        (x) => x.actor && x.caller.signedIn && expectedOutcome(rule, x.caller) === "403",
      )) {
        const req = B[key]({ org: c.org, ids: c.ids });
        const res = await server.request(`/api/v1${req.path}`, c.actor, {
          method: req.method,
          json: { unexpectedField: true },
          headers: { "X-Organization-Id": c.org },
        });
        if (res.status !== 403) problems.push(`${key} as ${c.name}: HTTP ${res.status}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
