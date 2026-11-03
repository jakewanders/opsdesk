import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { B, type Ids } from "@/test/api-requests";
import { hashRequest } from "@/lib/api/idempotency";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";
import { ENDPOINTS, expectedOutcome, type Caller } from "@/lib/permissions/endpoints";

/**
 * [P-05, SIT-145] The API contract matrix: every documented (endpoint x status) cell of docs/openapi.yaml is exercised against the real
 * server and database, and every response is checked against the envelope (PRD 7.1): `{ data, meta }` on success, `{ error: { code,
 * message, requestId } }` on failure with the same id in `X-Request-Id`, no SQL or stack text, `Retry-After` on 429.
 *
 * Statuses come from three places: generic probes derived from the endpoint classification and the request builders (401, 400, 403, 404,
 * 409, 422), specific probes below (every success, plus cases the generics cannot reach), and a short, explicit list of cells proven by
 * a named test elsewhere (rate limits and size caps need their own fixtures). The last test fails when a documented cell is in none of
 * the three, and it prints the table that docs/API_TEST_COVERAGE.md records. Routes the spec does not list are rejected by openapi.test.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const server = new RealServer();
const UNKNOWN = "00000000-0000-4000-8000-000000000999";
let owner: Actor,
  viewer: Actor,
  member: Actor,
  outsider: Actor,
  other: Actor,
  guest: Actor,
  registered: Actor;
let orgA = "";
let orgOther = "";
let demoOrg = "";
let ids: Ids;
let idsDemo: Ids;

/** endpoint key -> statuses actually observed with a valid envelope */
const observed = new Map<string, Set<number>>();
const note = (key: string, status: number) => {
  if (!observed.has(key)) observed.set(key, new Set());
  observed.get(key)!.add(status);
};

const ERROR_LEAK =
  /select .* from|insert into|\bat \S+\.(ts|js|mjs):\d+|SQLSTATE|pg_|postgres(ql)?\b|stack/i;
async function envelope(res: Response, status: number, label: string) {
  expect(res.status, label).toBe(status);
  expect(res.headers.get("x-request-id"), `${label}: X-Request-Id`).toBeTruthy();
  expect(res.headers.get("cache-control") ?? "", `${label}: never shared-cached`).toMatch(
    /no-store|private/,
  );
  const type = res.headers.get("content-type") ?? "";
  if (status === 204) {
    expect(await res.clone().text(), `${label}: 204 has no body`).toBe("");
    return;
  }
  if (!type.includes("json")) {
    // the CSV and PDF downloads: a body, a download name, and nothing that looks like an error envelope
    expect(status, label).toBeLessThan(300);
    expect(type, label).toMatch(/pdf|csv/);
    return;
  }
  const body = (await res.clone().json()) as Record<string, unknown>;
  if (status < 300) {
    expect(body, `${label}: success envelope`).toHaveProperty("data");
    expect(typeof body.meta, `${label}: meta is an object`).toBe("object");
    return;
  }
  const error = body.error as {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    fieldErrors?: unknown;
  };
  expect(typeof error?.code, `${label}: error.code`).toBe("string");
  expect(typeof error?.message, `${label}: error.message`).toBe("string");
  expect(error.requestId, `${label}: error.requestId equals X-Request-Id`).toBe(
    res.headers.get("x-request-id"),
  );
  expect(JSON.stringify(body), `${label}: nothing internal in the message`).not.toMatch(ERROR_LEAK);
  if (status === 422 && error.fieldErrors !== undefined)
    expect(typeof error.fieldErrors, `${label}: fieldErrors`).toBe("object");
  if (status === 429) {
    const retry = res.headers.get("retry-after");
    // time-based limits say when to come back; capacity limits (a full demo, a per-user workspace limit) have nothing to wait for
    if (["RATE_LIMITED", "DEMO_RESET_THROTTLED", "DEMO_CAPACITY"].includes(String(error.code)))
      expect(retry, `${label}: Retry-After`).toMatch(/^\d+$/);
    else if (retry !== null) expect(retry, `${label}: Retry-After`).toMatch(/^\d+$/);
  }
}

async function hit(
  key: string,
  status: number,
  run: () => Promise<Response> | Response,
  label = "",
) {
  const res = await run();
  await envelope(res, status, `${key} ${status} ${label}`.trim());
  note(key, status);
  return res;
}

// ---- documented cells, read from docs/openapi.yaml
function loadSpec(): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let path = "";
  let method = "";
  let inPaths = false;
  let inResponses = false;
  for (const line of readFileSync("docs/openapi.yaml", "utf8").split("\n")) {
    if (/^paths:/.test(line)) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p) [path, method, inResponses] = [p[1], "", false];
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m) [method, inResponses] = [m[1].toUpperCase(), false];
    if (/^ {6}responses:\s*$/.test(line)) inResponses = true;
    else if (/^ {6}\S/.test(line)) inResponses = false;
    const c = /^ {8}"?(\d{3})"?:/.exec(line);
    if (inResponses && c && method) {
      const key = `${method} ${path}`;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(Number(c[1]));
    }
  }
  return map;
}
const documented = loadSpec();

// ---- fixtures
const h = (org: string) => ({ "X-Organization-Id": org });
async function post(actor: Actor, org: string, path: string, json: unknown) {
  const res = await server.request(`/api/v1${path}`, actor, { json, headers: h(org) });
  return res;
}
async function create(
  actor: Actor,
  org: string,
  path: string,
  json: unknown,
): Promise<Record<string, any>> {
  const res = await post(actor, org, path, json);
  expect(res.status, `fixture ${path}`).toBe(201);
  return (await res.json()).data;
}
const fresh = {
  customer: () =>
    create(owner, orgA, "/customers", {
      displayName: `Contract Co ${Math.random().toString(36).slice(2, 7)}`,
    }),
  deal: async () =>
    create(owner, orgA, "/opportunities", {
      customerId: (await fresh.customer()).id,
      title: "Contract deal",
      amountCents: 1000,
    }),
  task: () => create(owner, orgA, "/tasks", { title: "Contract task" }),
  quote: async () =>
    create(owner, orgA, "/quotes", {
      customerId: (await fresh.customer()).id,
      title: "Contract quote",
      items: [{ description: "Line", quantity: 1, unitPriceCents: 500 }],
    }),
};
const get = (actor: Actor | null, org: string | null, path: string) =>
  server.request(`/api/v1${path}`, actor, { headers: org ? h(org) : undefined });
const send = (
  actor: Actor | null,
  org: string | null,
  method: string,
  path: string,
  json?: unknown,
) => server.request(`/api/v1${path}`, actor, { method, json, headers: org ? h(org) : undefined });

beforeAll(async () => {
  await server.start();
  [owner, viewer, member, outsider, other, guest, registered] = await Promise.all([
    server.member("ct-owner"),
    server.member("ct-viewer"),
    server.member("ct-member"),
    server.member("ct-outsider"),
    server.member("ct-other"),
    server.guest(),
    server.member("ct-registered"),
  ]);
  const mk = async (actor: Actor, name: string) =>
    (await (await server.request("/api/v1/organizations", actor, { json: { name } })).json()).data
      .id as string;
  orgA = await mk(owner, "Contract Co");
  orgOther = await mk(other, "Contract Other");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${orgA}', '${viewer.id}', 'viewer'), ('${orgA}', '${member.id}', 'member')`,
  );
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
  const seed = async (actor: Actor, org: string): Promise<Ids> => {
    const customer = (await create(actor, org, "/customers", { displayName: "Seed customer" }))
      .id as string;
    const opportunity = (
      await create(actor, org, "/opportunities", { customerId: customer, title: "Seed deal" })
    ).id as string;
    const task = (await create(actor, org, "/tasks", { title: "Seed task" })).id as string;
    const quote = (
      await create(actor, org, "/quotes", {
        customerId: customer,
        title: "Seed quote",
        items: [{ description: "Line", quantity: 1, unitPriceCents: 100 }],
      })
    ).id as string;
    return { customer, opportunity, task, quote };
  };
  ids = await seed(owner, orgA);
  idsDemo = await seed(guest, demoOrg);
}, 400_000);
afterAll(() => server.stop());

type Who = { actor: Actor | null; org: string; ids: Ids; caller: Caller; name: string };
const reg = (m: { role: string; kind: string } | null): Caller => ({
  signedIn: true,
  anonymous: false,
  membership: m,
});
const callers = (): Who[] => [
  { name: "viewer", actor: viewer, org: orgA, ids, caller: reg({ role: "viewer", kind: "real" }) },
  { name: "non-member", actor: outsider, org: orgA, ids, caller: reg(null) },
  { name: "registered user", actor: registered, org: orgA, ids, caller: reg(null) },
  {
    name: "guest in a real workspace",
    actor: guest,
    org: orgA,
    ids,
    caller: { signedIn: true, anonymous: true, membership: null },
  },
  { name: "owner", actor: owner, org: orgA, ids, caller: reg({ role: "owner", kind: "real" }) },
];
const usesHeader = (key: string) => ENDPOINTS[key].who === "org";
const callBuilt = (
  key: string,
  who: Who,
  mutate?: (r: { method: string; path: string; json?: unknown }) => {
    method: string;
    path: string;
    json?: unknown;
  },
) => {
  let req = B[key]({ org: who.org, ids: who.ids });
  if (mutate) req = mutate(req);
  return server.request(`/api/v1${req.path}`, who.actor, {
    method: req.method,
    json: req.json,
    headers: usesHeader(key) ? h(who.org) : undefined,
  });
};

/** Disables the user triggers (activity log, caps) around a bulk fixture insert as the database owner, then enables them again. */
function bulk(tables: string[], sql: string) {
  for (const t of tables) psql(`alter table public.${t} disable trigger user`);
  try {
    psql(sql);
  } finally {
    for (const t of tables) psql(`alter table public.${t} enable trigger user`);
  }
}
const capOf = (key: string) =>
  Number(psql(`select value from private.app_limits where key = '${key}'`));
/** Fills a demo workspace to exactly its cap for one entity, so the next API create is refused with 429 DEMO_CAP. */
function fillToCap(
  org: string,
  entity: "customers" | "opportunities" | "tasks" | "quotes" | "import_jobs",
  capKey: string,
  creator: string,
) {
  const have = Number(
    psql(`select count(*) from public.${entity} where organization_id = '${org}'`),
  );
  const n = capOf(capKey) - have;
  if (n <= 0) return;
  const customer = psql(`select id from public.customers where organization_id = '${org}' limit 1`);
  const sql: Record<string, string> = {
    customers: `insert into public.customers (organization_id, display_name) select '${org}', 'Cap fill ' || i from generate_series(1, ${n}) i`,
    opportunities: `insert into public.opportunities (organization_id, customer_id, title) select '${org}', '${customer}', 'Cap fill ' || i from generate_series(1, ${n}) i`,
    tasks: `insert into public.tasks (organization_id, title) select '${org}', 'Cap fill ' || i from generate_series(1, ${n}) i`,
    quotes: `insert into public.quotes (organization_id, customer_id, quote_number, title) select '${org}', '${customer}', 'Q-' || (800000 + i), 'Cap fill ' || i from generate_series(1, ${n}) i`,
    import_jobs: `insert into public.import_jobs (organization_id, created_by, file_sha256, total_rows) select '${org}', '${creator}', md5(i::text || random()::text) || md5(random()::text), 1 from generate_series(1, ${n}) i`,
  };
  bulk([entity], sql[entity]);
}
async function bootedGuest() {
  const g = await server.guest();
  const res = await server.request("/api/v1/demo/bootstrap", g, { method: "POST" });
  expect(res.status).toBe(200);
  return { g, org: (await res.json()).data.organizationId as string };
}
const b64 = (n: number) => Buffer.alloc(n, 0x61).toString("base64");
const TWO_MB = 2 * 1024 * 1024;

// ---- specific probes: every success, and the cells the generic probes cannot reach
type Probe = Record<number, () => Promise<Response> | Response>;
let doneCustomer = "";
const SPECIFIC: Record<string, () => Probe> = {
  "GET /session": () => ({ 200: () => get(owner, null, "/session") }),
  "GET /organizations": () => ({ 200: () => get(owner, null, "/organizations") }),
  "POST /organizations": () => ({
    201: () =>
      send(registered, null, "POST", "/organizations", { name: `Contract Created ${Date.now()}` }),
    422: () => send(registered, null, "POST", "/organizations", { name: "" }),
    429: async () => {
      const u = await server.member("ct-orglimit");
      let last: Response = new Response(null);
      for (let i = 0; i < capOf("max_real_orgs_per_user") + 1; i++)
        last = await send(u, null, "POST", "/organizations", { name: `Limit ${i}` });
      return last;
    },
  }),
  "GET /organizations/{id}": () => ({
    200: () => get(owner, null, `/organizations/${orgA}`),
    404: () => get(outsider, null, `/organizations/${orgA}`),
  }),
  "PATCH /organizations/{id}": () => ({
    200: async () => {
      const cur = (await (await get(owner, null, `/organizations/${orgA}`)).json()).data;
      return send(owner, orgA, "PATCH", `/organizations/${orgA}`, {
        name: "Contract Co",
        expectedUpdatedAt: cur.updatedAt,
      });
    },
    422: () => send(owner, orgA, "PATCH", `/organizations/${orgA}`, {}),
  }),
  "GET /customers": () => ({
    200: () => get(owner, orgA, "/customers"),
    422: () => get(owner, orgA, "/customers?limit=101"),
  }),
  "POST /customers": () => ({
    201: () => post(owner, orgA, "/customers", { displayName: "Contract created" }),
    422: () => post(owner, orgA, "/customers", {}),
  }),
  "GET /customers/{id}": () => ({ 200: () => get(owner, orgA, `/customers/${ids.customer}`) }),
  "PATCH /customers/{id}": () => ({
    200: async () => {
      const c = await fresh.customer();
      return send(owner, orgA, "PATCH", `/customers/${c.id}`, {
        notes: "updated",
        expectedUpdatedAt: c.updatedAt,
      });
    },
    422: () => send(owner, orgA, "PATCH", `/customers/${ids.customer}`, {}),
  }),
  "DELETE /customers/{id}": () => ({
    204: async () => send(owner, orgA, "DELETE", `/customers/${(await fresh.customer()).id}`),
  }),
  "POST /customers/{id}/restore": () => ({
    200: async () => {
      const c = await fresh.customer();
      await send(owner, orgA, "DELETE", `/customers/${c.id}`);
      doneCustomer = c.id;
      return send(owner, orgA, "POST", `/customers/${c.id}/restore`);
    },
  }),
  "GET /opportunities": () => ({
    200: () => get(owner, orgA, "/opportunities"),
    422: () => get(owner, orgA, "/opportunities?limit=101"),
  }),
  "POST /opportunities": () => ({
    201: () =>
      post(owner, orgA, "/opportunities", {
        customerId: ids.customer,
        title: "Contract created deal",
      }),
    422: () => post(owner, orgA, "/opportunities", {}),
    404: () =>
      post(owner, orgA, "/opportunities", {
        customerId: UNKNOWN,
        title: "Contract deal for nobody",
      }),
  }),
  "GET /opportunities/{id}": () => ({
    200: () => get(owner, orgA, `/opportunities/${ids.opportunity}`),
  }),
  "PATCH /opportunities/{id}": () => ({
    200: async () => {
      const d = await fresh.deal();
      return send(owner, orgA, "PATCH", `/opportunities/${d.id}`, {
        description: "updated",
        expectedUpdatedAt: d.updatedAt,
      });
    },
    422: () => send(owner, orgA, "PATCH", `/opportunities/${ids.opportunity}`, {}),
  }),
  "DELETE /opportunities/{id}": () => ({
    204: async () => send(owner, orgA, "DELETE", `/opportunities/${(await fresh.deal()).id}`),
  }),
  "POST /opportunities/{id}/stage": () => ({
    200: async () => {
      const d = await fresh.deal();
      return send(owner, orgA, "POST", `/opportunities/${d.id}/stage`, {
        stage: "qualified",
        expectedUpdatedAt: d.updatedAt,
      });
    },
    422: async () =>
      send(owner, orgA, "POST", `/opportunities/${(await fresh.deal()).id}/stage`, {
        stage: "nonsense",
      }),
  }),
  "GET /tasks": () => ({
    200: () => get(owner, orgA, "/tasks"),
    422: () => get(owner, orgA, "/tasks?limit=101"),
  }),
  "POST /tasks": () => ({
    201: () => post(owner, orgA, "/tasks", { title: "Contract created task" }),
    422: () => post(owner, orgA, "/tasks", {}),
  }),
  "GET /tasks/{id}": () => ({ 200: () => get(owner, orgA, `/tasks/${ids.task}`) }),
  "PATCH /tasks/{id}": () => ({
    200: async () => {
      const t = await fresh.task();
      return send(owner, orgA, "PATCH", `/tasks/${t.id}`, {
        description: "updated",
        expectedUpdatedAt: t.updatedAt,
      });
    },
    422: () => send(owner, orgA, "PATCH", `/tasks/${ids.task}`, {}),
  }),
  "DELETE /tasks/{id}": () => ({
    204: async () => send(owner, orgA, "DELETE", `/tasks/${(await fresh.task()).id}`),
  }),
  "POST /tasks/{id}/complete": () => ({
    200: async () => {
      const t = await fresh.task();
      return send(owner, orgA, "POST", `/tasks/${t.id}/complete`, {
        completed: true,
        expectedUpdatedAt: t.updatedAt,
      });
    },
    422: async () => send(owner, orgA, "POST", `/tasks/${(await fresh.task()).id}/complete`, {}),
  }),
  "GET /members": () => ({ 200: () => get(owner, orgA, "/members") }),
  "PATCH /members/{userId}": () => ({
    200: () => send(owner, orgA, "PATCH", `/members/${member.id}`, { role: "member" }),
    422: () => send(owner, orgA, "PATCH", `/members/${member.id}`, { role: "emperor" }),
    409: () => send(owner, orgA, "PATCH", `/members/${owner.id}`, { role: "admin" }),
  }),
  "DELETE /members/{userId}": () => ({
    204: async () => {
      const temp = await server.member("ct-temp");
      psql(
        `insert into public.memberships (organization_id, user_id, role) values ('${orgA}', '${temp.id}', 'viewer')`,
      );
      return send(owner, orgA, "DELETE", `/members/${temp.id}`);
    },
    409: () => send(owner, orgA, "DELETE", `/members/${owner.id}`),
  }),
  "GET /invitations": () => ({ 200: () => get(owner, orgA, "/invitations") }),
  "POST /invitations": () => ({
    201: () =>
      post(owner, orgA, "/invitations", { email: `ct-${Date.now()}@example.test`, role: "member" }),
    422: () => post(owner, orgA, "/invitations", { email: "not-an-email", role: "member" }),
  }),
  "DELETE /invitations/{id}": () => ({
    204: async () => {
      const inv = await create(owner, orgA, "/invitations", {
        email: `ct-del-${Date.now()}@example.test`,
        role: "viewer",
      });
      return send(owner, orgA, "DELETE", `/invitations/${inv.id}`);
    },
  }),
  "GET /quotes": () => ({
    200: () => get(owner, orgA, "/quotes"),
    422: () => get(owner, orgA, "/quotes?limit=101"),
  }),
  "POST /quotes": () => ({
    201: async () =>
      post(owner, orgA, "/quotes", {
        customerId: ids.customer,
        title: "Contract created quote",
        items: [{ description: "Line", quantity: 1, unitPriceCents: 100 }],
      }),
    422: () =>
      post(owner, orgA, "/quotes", { customerId: ids.customer, title: "No lines", items: [] }),
  }),
  "GET /quotes/{id}": () => ({ 200: () => get(owner, orgA, `/quotes/${ids.quote}`) }),
  "PATCH /quotes/{id}": () => ({
    200: async () => {
      const q = await fresh.quote();
      return send(owner, orgA, "PATCH", `/quotes/${q.id}`, {
        title: "Contract updated",
        expectedVersion: q.version,
      });
    },
    422: () => send(owner, orgA, "PATCH", `/quotes/${ids.quote}`, {}),
  }),
  "GET /quotes/{id}/pdf": () => ({ 200: () => get(owner, orgA, `/quotes/${ids.quote}/pdf`) }),
  "POST /quotes/{id}/transition": () => ({
    200: async () => {
      const q = await fresh.quote();
      return send(owner, orgA, "POST", `/quotes/${q.id}/transition`, {
        to: "sent",
        expectedVersion: q.version,
      });
    },
    422: () =>
      send(owner, orgA, "POST", `/quotes/${ids.quote}/transition`, {
        to: "teleported",
        expectedVersion: 1,
      }),
  }),
  "POST /quotes/{id}/revise": () => ({
    201: async () => {
      const q = await fresh.quote();
      const sent = (
        await (
          await send(owner, orgA, "POST", `/quotes/${q.id}/transition`, {
            to: "sent",
            expectedVersion: q.version,
          })
        ).json()
      ).data;
      return send(owner, orgA, "POST", `/quotes/${sent.id}/revise`);
    },
    409: async () => {
      // a draft cannot be revised
      const q = await fresh.quote();
      return send(owner, orgA, "POST", `/quotes/${q.id}/revise`);
    },
  }),
  "GET /dashboard": () => ({ 200: () => get(owner, orgA, "/dashboard") }),
  "GET /reports": () => ({
    200: () => get(owner, orgA, "/reports?range=7"),
    422: () => get(owner, orgA, "/reports?range=14"),
  }),
  "GET /exports/{entity}": () => ({
    200: () => get(owner, orgA, "/exports/customers"),
    422: () => get(owner, orgA, "/exports/customers?status=bogus"),
    404: () => get(owner, orgA, "/exports/quotes"),
  }),
  "GET /activity": () => ({
    200: () => get(owner, orgA, "/activity"),
    422: () => get(owner, orgA, "/activity?limit=101"),
  }),
  "POST /imports/customers/preview": () => ({
    // the same file again: the job already exists, so the answer is 200 and not a second 201
    200: async () => {
      const content = Buffer.from(`display_name\nContract Repeat ${Date.now()}\n`).toString(
        "base64",
      );
      await post(owner, orgA, "/imports/customers/preview", { content });
      return post(owner, orgA, "/imports/customers/preview", { content });
    },
    201: () =>
      post(owner, orgA, "/imports/customers/preview", {
        content: Buffer.from(`display_name\nContract Import ${Date.now()}\n`).toString("base64"),
      }),
    422: () => post(owner, orgA, "/imports/customers/preview", { content: "!!!not base64!!!" }),
  }),
  "POST /imports/customers/commit": () => ({
    200: async () => {
      const content = Buffer.from(`display_name\nContract Commit ${Date.now()}\n`).toString(
        "base64",
      );
      const prev = (
        await (await post(owner, orgA, "/imports/customers/preview", { content })).json()
      ).data;
      return post(owner, orgA, "/imports/customers/commit", {
        importJobId: prev.importJobId,
        content,
      });
    },
    422: () => post(owner, orgA, "/imports/customers/commit", { importJobId: "nope" }),
  }),
  "GET /imports/customers/{jobId}/errors": () => ({
    200: async () => {
      const content = Buffer.from("display_name\n,\nValid Contract Row\n").toString("base64");
      const prev = (
        await (await post(owner, orgA, "/imports/customers/preview", { content })).json()
      ).data;
      return get(owner, orgA, `/imports/customers/${prev.importJobId}/errors`);
    },
  }),
  "POST /invitations/preview": () => ({
    404: () => send(registered, null, "POST", "/invitations/preview", { token: "0".repeat(64) }),
    422: () => send(registered, null, "POST", "/invitations/preview", {}),
  }),
  "POST /invitations/accept": () => ({
    404: () => send(registered, null, "POST", "/invitations/accept", { token: "0".repeat(64) }),
    422: () => send(registered, null, "POST", "/invitations/accept", {}),
  }),
  "POST /demo/bootstrap": () => ({
    200: async () => send(await server.guest(), null, "POST", "/demo/bootstrap"),
    422: async () =>
      server.request("/api/v1/demo/bootstrap", await server.guest(), {
        method: "POST",
        headers: { "Idempotency-Key": "bad key!" },
      }),
    409: async () => {
      const g = await server.guest();
      const key = `ct-inprogress-${Date.now()}`;
      psql(
        `insert into private.idempotency_keys (user_id, route, key, request_hash, state, expires_at) values ('${g.id}', 'POST /api/v1/demo/bootstrap', '${key}', '${hashRequest({})}', 'in_progress', now() + interval '1 day')`,
      );
      return server.request("/api/v1/demo/bootstrap", g, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
    },
    429: async () => {
      const limit = capOf("max_active_demos");
      const active = Number(
        psql(
          "select count(*) from public.organizations where kind = 'demo' and expires_at > now()",
        ),
      );
      psql(`update private.app_limits set value = ${active} where key = 'max_active_demos'`);
      try {
        return await server.request("/api/v1/demo/bootstrap", await server.guest(), {
          method: "POST",
        });
      } finally {
        psql(`update private.app_limits set value = ${limit} where key = 'max_active_demos'`);
      }
    },
  }),
  "POST /demo/reset": () => ({
    200: async () => send((await bootedGuest()).g, null, "POST", "/demo/reset"),
    404: async () => send(await server.guest(), null, "POST", "/demo/reset"),
    429: async () => {
      const { g } = await bootedGuest();
      expect((await send(g, null, "POST", "/demo/reset")).status).toBe(200);
      return send(g, null, "POST", "/demo/reset");
    },
    409: async () => {
      const { g } = await bootedGuest();
      const key = `ct-inprogress-${Date.now()}`;
      psql(
        `insert into private.idempotency_keys (user_id, route, key, request_hash, state, expires_at) values ('${g.id}', 'POST /api/v1/demo/reset', '${key}', '${hashRequest({})}', 'in_progress', now() + interval '1 day')`,
      );
      return server.request("/api/v1/demo/reset", g, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
    },
  }),
};

/** The rate limits, caps, size limits and invitation states: each needs its own fixture, so they are probed here rather than inline. */
const capProbe =
  (
    path: string,
    entity: "customers" | "opportunities" | "tasks" | "quotes",
    capKey: string,
    body: (customer: string) => unknown,
  ) =>
  async () => {
    const { g, org } = await bootedGuest();
    fillToCap(org, entity, capKey, g.id);
    const customer = psql(
      `select id from public.customers where organization_id = '${org}' limit 1`,
    );
    return post(g, org, path, body(customer));
  };
async function inviteTo(actor: Actor, org: string, email: string, role = "member") {
  return (await create(actor, org, "/invitations", { email, role })) as {
    id: string;
    token: string;
  };
}
const SPECIFIC_EXTRA: Record<string, () => Probe> = {
  "POST /customers": () => ({
    429: capProbe("/customers", "customers", "demo_cap_customers", () => ({
      displayName: "One too many",
    })),
  }),
  "POST /opportunities": () => ({
    429: capProbe("/opportunities", "opportunities", "demo_cap_opportunities", (customerId) => ({
      customerId,
      title: "One too many",
    })),
  }),
  "POST /tasks": () => ({
    429: capProbe("/tasks", "tasks", "demo_cap_tasks", () => ({ title: "One too many" })),
  }),
  "POST /quotes": () => ({
    429: capProbe("/quotes", "quotes", "demo_cap_quotes", (customerId) => ({
      customerId,
      title: "One too many",
      items: [{ description: "Line", quantity: 1, unitPriceCents: 100 }],
    })),
  }),
  "POST /invitations": () => ({
    409: async () => {
      const email = `ct-dup-${Date.now()}@example.test`;
      await inviteTo(owner, orgA, email);
      return post(owner, orgA, "/invitations", { email, role: "member" });
    },
    429: async () => {
      const boss = await server.member("ct-invitecap");
      const org = (
        await (
          await server.request("/api/v1/organizations", boss, { json: { name: "Invite cap" } })
        ).json()
      ).data.id as string;
      const n = capOf("max_open_invitations_per_org");
      bulk(
        ["invitations"],
        `insert into public.invitations (organization_id, email_normalized, role, token_hash, invited_by) select '${org}', 'cap' || i || '@example.test', 'member', md5(i::text || 'a') || md5(i::text || 'b'), '${boss.id}' from generate_series(1, ${n}) i`,
      );
      return post(boss, org, "/invitations", {
        email: "one-too-many@example.test",
        role: "member",
      });
    },
  }),
  "DELETE /invitations/{id}": () => ({
    409: async () => {
      const joiner = await server.member("ct-joiner-del");
      const inv = await inviteTo(owner, orgA, joiner.email!);
      expect(
        (await send(joiner, null, "POST", "/invitations/accept", { token: inv.token })).status,
      ).toBe(200);
      return send(owner, orgA, "DELETE", `/invitations/${inv.id}`);
    },
  }),
  "POST /invitations/accept": () => ({
    200: async () => {
      const joiner = await server.member("ct-joiner");
      const inv = await inviteTo(owner, orgA, joiner.email!);
      return send(joiner, null, "POST", "/invitations/accept", { token: inv.token });
    },
    409: async () => {
      const joiner = await server.member("ct-joiner-rev");
      const inv = await inviteTo(owner, orgA, joiner.email!);
      expect((await send(owner, orgA, "DELETE", `/invitations/${inv.id}`)).status).toBe(204);
      return send(joiner, null, "POST", "/invitations/accept", { token: inv.token });
    },
    429: async () => {
      const guesser = await server.member("ct-guesser-a");
      let last: Response = new Response(null);
      for (let i = 0; i < capOf("invitation_redeem_attempts_per_15_min") + 1; i++)
        last = await send(guesser, null, "POST", "/invitations/accept", {
          token: i.toString(16).padStart(64, "0"),
        });
      return last;
    },
  }),
  "POST /invitations/preview": () => ({
    200: async () => {
      const joiner = await server.member("ct-joiner-prev");
      const inv = await inviteTo(owner, orgA, joiner.email!);
      return send(joiner, null, "POST", "/invitations/preview", { token: inv.token });
    },
    409: async () => {
      const joiner = await server.member("ct-joiner-prev2");
      const inv = await inviteTo(owner, orgA, joiner.email!);
      await send(owner, orgA, "DELETE", `/invitations/${inv.id}`);
      return send(joiner, null, "POST", "/invitations/preview", { token: inv.token });
    },
    429: async () => {
      const guesser = await server.member("ct-guesser-p");
      let last: Response = new Response(null);
      for (let i = 0; i < capOf("invitation_redeem_attempts_per_15_min") + 1; i++)
        last = await send(guesser, null, "POST", "/invitations/preview", {
          token: i.toString(16).padStart(64, "0"),
        });
      return last;
    },
  }),
  "POST /imports/customers/preview": () => ({
    413: () => post(owner, orgA, "/imports/customers/preview", { content: b64(TWO_MB + 1) }),
    429: async () => {
      const { g, org } = await bootedGuest();
      fillToCap(org, "import_jobs", "demo_cap_import_jobs", g.id);
      return post(g, org, "/imports/customers/preview", {
        content: Buffer.from(`display_name\nCap ${Date.now()}\n`).toString("base64"),
      });
    },
  }),
  "POST /imports/customers/commit": () => ({
    413: () =>
      post(owner, orgA, "/imports/customers/commit", {
        importJobId: UNKNOWN,
        content: b64(TWO_MB + 1),
      }),
    409: async () => {
      const content = Buffer.from(`display_name\nContract Expired ${Date.now()}\n`).toString(
        "base64",
      );
      const prev = (
        await (await post(owner, orgA, "/imports/customers/preview", { content })).json()
      ).data;
      psql("alter table public.import_jobs disable trigger import_jobs_protect_columns");
      psql(
        `update public.import_jobs set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = '${prev.importJobId}'`,
      );
      psql("alter table public.import_jobs enable trigger import_jobs_protect_columns");
      return post(owner, orgA, "/imports/customers/commit", {
        importJobId: prev.importJobId,
        content,
      });
    },
    429: async () => {
      const { g, org } = await bootedGuest();
      const content = Buffer.from(
        "display_name\nCap Import A\nCap Import B\nCap Import C\n",
      ).toString("base64");
      const prev = (await (await post(g, org, "/imports/customers/preview", { content })).json())
        .data;
      fillToCap(org, "customers", "demo_cap_customers", g.id);
      bulk(
        ["customers"],
        `delete from public.customers where id in (select id from public.customers where organization_id = '${org}' and display_name like 'Cap fill %' limit 1)`,
      );
      return post(g, org, "/imports/customers/commit", { importJobId: prev.importJobId, content });
    },
  }),
};

// ---- cells proven by a named test elsewhere (they need their own fixtures); each reference is verified to exist
const ELSEWHERE: Record<string, { file: string; test: string }> = {};

describe("API contract matrix: every documented endpoint x status [P-05]", () => {
  it("the spec and the endpoint classification list the same endpoints", () => {
    const norm = (k: string) => k.replace(/\{[^}]+\}/g, "{}");
    expect([...documented.keys()].map(norm).sort()).toEqual(
      Object.keys(ENDPOINTS).map(norm).sort(),
    );
  });

  for (const key of Object.keys(ENDPOINTS)) {
    it(
      key,
      async () => {
        const docs = documented.get(key) ?? new Set<number>();
        const rule = ENDPOINTS[key];
        const specific: Probe = {
          ...(SPECIFIC[key]?.() ?? {}),
          ...(SPECIFIC_EXTRA[key]?.() ?? {}),
        };
        const callerOf = (want: string) =>
          callers().find((c) => expectedOutcome(rule, c.caller) === want);

        // 401: signed out
        if (docs.has(401) && rule.who !== "member-of-path")
          await hit(key, 401, () =>
            callBuilt(key, {
              name: "signed out",
              actor: null,
              org: orgA,
              ids,
              caller: { signedIn: false },
            }),
          );
        if (docs.has(401) && rule.who === "member-of-path")
          await hit(key, 401, () =>
            callBuilt(key, {
              name: "signed out",
              actor: null,
              org: orgA,
              ids,
              caller: { signedIn: false },
            }),
          );
        // 403: a caller the permission module says is forbidden
        const forbidden = callerOf("403");
        if (docs.has(403) && forbidden)
          await hit(key, 403, () => callBuilt(key, forbidden), forbidden.name);
        // 404: a stranger to the workspace, or an unknown id
        if (docs.has(404) && !specific[404]) {
          const stranger = callerOf("404");
          if (rule.who === "org" && stranger)
            await hit(key, 404, () => callBuilt(key, stranger), stranger.name);
          else if (
            /[0-9a-f]{8}-[0-9a-f-]{27}/.test(B[key]({ org: orgA, ids }).path) ||
            /\{id\}|\{jobId\}|\{userId\}/.test(key)
          ) {
            const unknown = callers().find((c) => c.name === "owner")!;
            await hit(key, 404, () =>
              callBuilt(key, unknown, (r) => ({
                ...r,
                path: r.path.replace(
                  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
                  UNKNOWN,
                ),
              })),
            );
          }
        }
        // 400: a malformed id in the path
        if (docs.has(400)) {
          const o = callers().find((c) => c.name === "owner")!;
          await hit(key, 400, () =>
            callBuilt(key, o, (r) => ({
              ...r,
              path: r.path.replace(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
                "not-a-uuid",
              ),
            })),
          );
        }
        // 409: the builders carry a stale version; an allowed caller gets 409
        if (
          docs.has(409) &&
          !specific[409] &&
          /PATCH|transition|stage|complete/.test(key) &&
          rule.who === "org"
        ) {
          const o = callers().find((c) => c.name === "owner")!;
          await hit(key, 409, () => callBuilt(key, o));
        }
        // the specific probes
        for (const [status, run] of Object.entries(specific)) await hit(key, Number(status), run);
      },
      120_000,
    );
  }

  it("rollback leaves nothing half-created: a quote that fails validation, an organization that fails, a refused membership", async () => {
    const count = (sql: string) => Number(psql(sql));
    const quotesBefore = count(
      `select count(*) from public.quotes where organization_id = '${orgA}'`,
    );
    const seqBefore = psql(
      `select coalesce(max(next_number)::text, '0') from public.quote_sequences where organization_id = '${orgA}'`,
    );
    const eventsBefore = count(
      `select count(*) from public.activity_events where organization_id = '${orgA}'`,
    );
    const bad = await post(owner, orgA, "/quotes", {
      customerId: ids.customer,
      title: "Bad lines",
      items: [
        { description: "Line", quantity: 1, unitPriceCents: 100 },
        { description: "", quantity: 0, unitPriceCents: -5 },
      ],
    });
    expect(bad.status).toBe(422);
    expect(count(`select count(*) from public.quotes where organization_id = '${orgA}'`)).toBe(
      quotesBefore,
    );
    expect(
      psql(
        `select coalesce(max(next_number)::text, '0') from public.quote_sequences where organization_id = '${orgA}'`,
      ),
    ).toBe(seqBefore);
    expect(
      count(`select count(*) from public.activity_events where organization_id = '${orgA}'`),
    ).toBe(eventsBefore);
    const orgsBefore = count("select count(*) from public.organizations");
    const membershipsBefore = count("select count(*) from public.memberships");
    const badOrg = await server.request("/api/v1/organizations", registered, {
      json: { name: "Bad zone", timezone: "Mars/Olympus" },
    });
    expect(badOrg.status).toBe(422);
    expect(count("select count(*) from public.organizations")).toBe(orgsBefore);
    expect(count("select count(*) from public.memberships")).toBe(membershipsBefore);
    const refused = await send(viewer, orgA, "PATCH", `/members/${member.id}`, { role: "admin" });
    expect(refused.status).toBe(403);
    expect(
      psql(
        `select role from public.memberships where organization_id = '${orgA}' and user_id = '${member.id}'`,
      ),
    ).toBe("member");
  });

  it("every successful write has its audit event, in the same transaction", async () => {
    const before = Number(
      psql(`select count(*) from public.activity_events where organization_id = '${orgA}'`),
    );
    const c = await create(owner, orgA, "/customers", { displayName: "Audited customer" });
    const d = await create(owner, orgA, "/opportunities", {
      customerId: c.id,
      title: "Audited deal",
    });
    const t = await create(owner, orgA, "/tasks", { title: "Audited task" });
    const q = await create(owner, orgA, "/quotes", {
      customerId: c.id,
      title: "Audited quote",
      items: [{ description: "Line", quantity: 1, unitPriceCents: 100 }],
    });
    await send(owner, orgA, "PATCH", `/customers/${c.id}`, {
      notes: "n",
      expectedUpdatedAt: c.updatedAt,
    });
    const after = Number(
      psql(`select count(*) from public.activity_events where organization_id = '${orgA}'`),
    );
    expect(after - before).toBeGreaterThanOrEqual(5);
    for (const [type, id] of [
      ["customer", c.id],
      ["opportunity", d.id],
      ["task", t.id],
      ["quote", q.id],
    ])
      expect(
        Number(
          psql(
            `select count(*) from public.activity_events where organization_id = '${orgA}' and entity_type = '${type}' and entity_id = '${id}'`,
          ),
        ),
        `${type} has an event`,
      ).toBeGreaterThanOrEqual(1);
  });

  it("covers every documented cell, or names the test that does, and the committed coverage table matches", () => {
    const lines: string[] = [];
    const gaps: string[] = [];
    let cells = 0;
    for (const [key, codes] of [...documented.entries()].sort()) {
      const marks = [...codes].sort().map((code) => {
        cells += 1;
        if (observed.get(key)?.has(code)) return String(code);
        const ref = ELSEWHERE[`${key}:${code}`];
        if (ref) {
          expect(readFileSync(ref.file, "utf8"), `${key}:${code} -> ${ref.file}`).toContain(
            ref.test,
          );
          return `${code} (${ref.file.split("/").pop()})`;
        }
        gaps.push(`${key} ${code}`);
        return `${code} GAP`;
      });
      const extra = [...(observed.get(key) ?? [])].filter((c) => !codes.has(c)).sort();
      lines.push(
        `| \`${key}\` | ${marks.join(", ")}${extra.length ? ` (also seen: ${extra.join(", ")})` : ""} |`,
      );
    }
    expect(gaps, "documented cells with no probe and no reference").toEqual([]);
    const table = [
      "| Endpoint | Documented statuses, each exercised with a valid envelope |",
      "| --- | --- |",
      ...lines,
    ].join("\n");
    const doc = `# API test coverage (generated)\n\nGenerated by \`src/lib/api/api-contract.integration.test.ts\` (P-05): ${cells} documented endpoint x status cells across ${documented.size} endpoints, every one called against the real server and database and checked against the response envelope (\`{ data, meta }\` or \`{ error: { code, message, requestId } }\`, the same id in \`X-Request-Id\`, no SQL or stack text, \`Retry-After\` on time-based 429s). Regenerate with \`UPDATE_API_COVERAGE=1 npm run test:integration -- src/lib/api/api-contract\`; the test fails when this file is out of date or a documented cell is not exercised.\n\n${table}\n`;
    if (process.env.UPDATE_API_COVERAGE) writeFileSync("docs/API_TEST_COVERAGE.md", doc);
    else {
      // the file is formatted by prettier (column widths); compare the content, not the padding
      const norm = (t: string) =>
        t
          .replace(/[ \t]+/g, " ")
          .replace(/-{2,}/g, "---")
          .trim();
      expect(norm(readFileSync("docs/API_TEST_COVERAGE.md", "utf8"))).toBe(norm(doc));
    }
  });
});
