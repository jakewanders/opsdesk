import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-254] The M2 role-aware and cross-tenant matrix through the API and through PostgREST (PRD 5.3, 8.4, 11.2, 12 M2).
 * The database half is `supabase/tests/m2-cross-tenant-matrix.test.sql`. Both are generated from tables: add a row to
 * ENTITIES (and the fixtures) to cover quotes or invitations in M4.
 *
 * API: every entity x every actor x list, get, create, patch, archive against a row of org A, plus the entity's action routes
 * (opportunity stage, task complete). PostgREST: the same tables hit directly with a valid user token, as a browser holding
 * the publishable key would; the database must refuse exactly what the API refuses.
 */
const server = new RealServer();
const A: Record<string, Actor> = {};
let orgA = "";
let orgB = "";
let demo1 = "";
let demo2 = "";
let expiredDemo = "";
let customerB = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const api = (actor: Actor | null, method: string, path: string, json?: unknown, org = orgA) =>
  server.request(`/api/v1${path}`, actor, { method, json, headers: hdr(org) });

type Entity = {
  name: string;
  path: string;
  table: string;
  /** body for POST, given a customer id of the same org */
  create: (customerId: string) => Record<string, unknown>;
  /** body for PATCH (the version is added) */
  patch: Record<string, unknown>;
  textColumn: string;
  /** the action route and its body, if any */
  action?: { route: string; body: (version: string) => Record<string, unknown> };
};
const ENTITIES: Entity[] = [
  {
    name: "customers",
    path: "/customers",
    table: "customers",
    create: () => ({ displayName: "M2 api customer" }),
    patch: { displayName: "M2 patched" },
    textColumn: "display_name",
  },
  {
    name: "opportunities",
    path: "/opportunities",
    table: "opportunities",
    create: (customerId) => ({ customerId, title: "M2 api deal" }),
    patch: { title: "M2 patched" },
    textColumn: "title",
    action: { route: "stage", body: (v) => ({ stage: "qualified", expectedUpdatedAt: v }) },
  },
  {
    name: "tasks",
    path: "/tasks",
    table: "tasks",
    create: () => ({ title: "M2 api task" }),
    patch: { title: "M2 patched" },
    textColumn: "title",
    action: { route: "complete", body: (v) => ({ completed: true, expectedUpdatedAt: v }) },
  },
];

/** expected status per action, for an actor sending org A's id. */
type Row = {
  actor: string;
  label: string;
  list: number;
  get: number;
  create: number;
  patch: number;
  archive: number;
  action: number;
};
const WRITER = { list: 200, get: 200, create: 201, patch: 200, archive: 204, action: 200 };
const ROLES: Row[] = [
  { actor: "owner", label: "owner", ...WRITER },
  { actor: "admin", label: "admin", ...WRITER },
  { actor: "member", label: "member", ...WRITER },
  {
    actor: "viewer",
    label: "viewer",
    list: 200,
    get: 200,
    create: 403,
    patch: 403,
    archive: 403,
    action: 403,
  },
  // not members of org A: the workspace is "not found", exactly as if it did not exist
  {
    actor: "other",
    label: "owner of org B",
    list: 404,
    get: 404,
    create: 404,
    patch: 404,
    archive: 404,
    action: 404,
  },
  {
    actor: "outsider",
    label: "user with no organization",
    list: 404,
    get: 404,
    create: 404,
    patch: 404,
    archive: 404,
    action: 404,
  },
  {
    actor: "guest1",
    label: "guest G1",
    list: 404,
    get: 404,
    create: 404,
    patch: 404,
    archive: 404,
    action: 404,
  },
  {
    actor: "guest2",
    label: "guest G2",
    list: 404,
    get: 404,
    create: 404,
    patch: 404,
    archive: 404,
    action: 404,
  },
  {
    actor: "anon",
    label: "signed-out visitor",
    list: 401,
    get: 401,
    create: 401,
    patch: 401,
    archive: 401,
    action: 401,
  },
];
const actorOf = (key: string): Actor | null => (key === "anon" ? null : A[key]);

async function freshRow(entity: Entity): Promise<{ id: string; updatedAt: string }> {
  const customer = entity.name === "customers" ? "" : await customerIdIn("A");
  const res = await api(A.owner, "POST", entity.path, entity.create(customer));
  expect(res.status, `fixture ${entity.name}`).toBe(201);
  const d = (await res.json()).data;
  return { id: d.id, updatedAt: d.updatedAt };
}
let customerA = "";
const customerIdIn = async (which: "A") => (which === "A" ? customerA : customerB);
const col = (entity: Entity, id: string) =>
  psql(`select ${entity.textColumn} from public.${entity.table} where id = '${id}'`);
const archived = (entity: Entity, id: string) =>
  psql(`select archived_at is not null from public.${entity.table} where id = '${id}'`);

beforeAll(async () => {
  await server.start();
  const [owner, admin, member, viewer, other, outsider, guest1, guest2, guest3] = await Promise.all(
    [
      server.member("m2-owner"),
      server.member("m2-admin"),
      server.member("m2-member"),
      server.member("m2-viewer"),
      server.member("m2-other"),
      server.member("m2-outsider"),
      server.guest(),
      server.guest(),
      server.guest(),
    ],
  );
  Object.assign(A, { owner, admin, member, viewer, other, outsider, guest1, guest2, guest3 });
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  orgA = await mk(owner, "M2 Matrix A");
  orgB = await mk(other, "M2 Matrix B");
  for (const [who, role] of [
    [admin, "admin"],
    [member, "member"],
    [viewer, "viewer"],
  ] as const)
    psql(
      `insert into public.memberships (organization_id, user_id, role) values ('${orgA}', '${who.id}', '${role}')`,
    );
  customerA = (
    await (await api(owner, "POST", "/customers", { displayName: "M2 customer A" })).json()
  ).data.id;
  customerB = (
    await (await api(other, "POST", "/customers", { displayName: "M2 customer B" }, orgB)).json()
  ).data.id;
  const boot = async (g: Actor) => {
    const r = await server.request("/api/v1/demo/bootstrap", g, { method: "POST" });
    expect(r.status).toBe(200);
    return (await r.json()).data.organizationId as string;
  };
  [demo1, demo2, expiredDemo] = await Promise.all([boot(guest1), boot(guest2), boot(guest3)]);
  psql(
    `update public.organizations set expires_at = now() - interval '1 minute' where id = '${expiredDemo}'`,
  );
}, 600_000);
afterAll(() => server.stop());

describe("API: entity x actor x action, against a row of org A", () => {
  for (const entity of ENTITIES) {
    describe(entity.name, () => {
      it.each(ROLES)("$label", async (role) => {
        const actor = actorOf(role.actor);
        const target = await freshRow(entity);
        const original = col(entity, target.id);

        const list = await api(actor, "GET", entity.path);
        expect(list.status, "list").toBe(role.list);
        if (role.list === 200) expect((await list.json()).data.length).toBeGreaterThan(0);
        else expect(JSON.stringify(await list.json())).not.toContain(target.id);

        const get = await api(actor, "GET", `${entity.path}/${target.id}`);
        expect(get.status, "get").toBe(role.get);

        const before = psql(
          `select count(*) from public.${entity.table} where organization_id = '${orgA}'`,
        );
        const created = await api(actor, "POST", entity.path, entity.create(customerA));
        expect(created.status, "create").toBe(role.create);
        if (role.create !== 201)
          expect(
            psql(`select count(*) from public.${entity.table} where organization_id = '${orgA}'`),
            "nothing written",
          ).toBe(before);

        const patched = await api(actor, "PATCH", `${entity.path}/${target.id}`, {
          ...entity.patch,
          expectedUpdatedAt: target.updatedAt,
        });
        expect(patched.status, "patch").toBe(role.patch);
        if (role.patch !== 200) expect(col(entity, target.id), "unchanged").toBe(original);

        if (entity.action) {
          const fresh = await freshRow(entity);
          const acted = await api(
            actor,
            "POST",
            `${entity.path}/${fresh.id}/${entity.action.route}`,
            entity.action.body(fresh.updatedAt),
          );
          expect(acted.status, entity.action.route).toBe(role.action);
          if (role.action !== 200)
            expect(
              psql(
                `select updated_at = '${fresh.updatedAt}'::timestamptz from public.${entity.table} where id = '${fresh.id}'`,
              ),
              "action wrote nothing",
            ).toBe("t");
        }

        const removed = await api(actor, "DELETE", `${entity.path}/${target.id}`);
        expect(removed.status, "archive").toBe(role.archive);
        expect(archived(entity, target.id), "archived only when allowed").toBe(
          role.archive === 204 ? "t" : "f",
        );
      });
    });
  }
});

describe("API: sending your own organization's id never reaches org A's rows", () => {
  it.each(ENTITIES)(
    "$name: the same 404 as a row that does not exist, for get, patch and archive; and the list never contains it",
    async (entity) => {
      const target = await freshRow(entity);
      const missing = crypto.randomUUID();
      const get = await api(A.other, "GET", `${entity.path}/${target.id}`, undefined, orgB);
      const getMissing = await api(A.other, "GET", `${entity.path}/${missing}`, undefined, orgB);
      expect([get.status, getMissing.status]).toEqual([404, 404]);
      expect((await get.json()).error.code).toBe((await getMissing.json()).error.code);
      expect(
        (
          await api(
            A.other,
            "PATCH",
            `${entity.path}/${target.id}`,
            { ...entity.patch, expectedUpdatedAt: target.updatedAt },
            orgB,
          )
        ).status,
      ).toBe(404);
      expect(
        (await api(A.other, "DELETE", `${entity.path}/${target.id}`, undefined, orgB)).status,
      ).toBe(404);
      const list = await (
        await api(A.other, "GET", `${entity.path}?limit=100`, undefined, orgB)
      ).json();
      expect(JSON.stringify(list)).not.toContain(target.id);
      expect(archived(entity, target.id)).toBe("f");
    },
  );
  it("guests: G1 cannot see or write G2's demo rows, with either organization id", async () => {
    for (const entity of ENTITIES) {
      const g2row = psql(
        `select id from public.${entity.table} where organization_id = '${demo2}' limit 1`,
      );
      expect(
        (await api(A.guest1, "GET", `${entity.path}/${g2row}`, undefined, demo2)).status,
        `${entity.name} get via G2's id`,
      ).toBe(404);
      expect(
        (await api(A.guest1, "GET", `${entity.path}/${g2row}`, undefined, demo1)).status,
        `${entity.name} get via own id`,
      ).toBe(404);
      expect(
        (await api(A.guest1, "DELETE", `${entity.path}/${g2row}`, undefined, demo2)).status,
      ).toBe(404);
      expect(archived(entity, g2row)).toBe("f");
    }
  });
  it("tampering: another tenant's customer, opportunity or assignee in a body is refused and writes nothing", async () => {
    const dealB = (
      await (
        await api(
          A.other,
          "POST",
          "/opportunities",
          { customerId: customerB, title: "M2 deal B" },
          orgB,
        )
      ).json()
    ).data.id;
    const cases: Array<[string, string, Record<string, unknown>, number]> = [
      ["POST", "/opportunities", { customerId: customerB, title: "tamper" }, 404],
      ["POST", "/tasks", { title: "tamper", customerId: customerB }, 404],
      ["POST", "/tasks", { title: "tamper", opportunityId: dealB }, 404],
      ["POST", "/tasks", { title: "tamper", assignedTo: A.other.id }, 422],
      [
        "POST",
        "/opportunities",
        { customerId: customerA, title: "tamper", assignedTo: A.other.id },
        422,
      ],
      ["POST", "/customers", { displayName: "tamper", assignedTo: A.other.id }, 422],
      ["POST", "/customers", { displayName: "tamper", organizationId: orgB }, 422],
      ["POST", "/tasks", { title: "tamper", organizationId: orgB }, 422],
    ];
    const before = psql(
      `select (select count(*) from public.customers) + (select count(*) from public.opportunities) + (select count(*) from public.tasks)`,
    );
    for (const [method, path, body, status] of cases)
      expect(
        (await api(A.member, method, path, body)).status,
        `${path} ${JSON.stringify(body)}`,
      ).toBe(status);
    expect(
      psql(
        `select (select count(*) from public.customers) + (select count(*) from public.opportunities) + (select count(*) from public.tasks)`,
      ),
    ).toBe(before);
  });
  it("an expired demo rejects every write with DEMO_EXPIRED and changes nothing", async () => {
    for (const entity of ENTITIES) {
      const row = psql(
        `select id from public.${entity.table} where organization_id = '${expiredDemo}' limit 1`,
      );
      const version = psql(
        `select to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') from public.${entity.table} where id = '${row}'`,
      );
      const customer = psql(
        `select id from public.customers where organization_id = '${expiredDemo}' limit 1`,
      );
      for (const [method, path, body] of [
        ["POST", entity.path, entity.create(customer)],
        ["PATCH", `${entity.path}/${row}`, { ...entity.patch, expectedUpdatedAt: version }],
        ["DELETE", `${entity.path}/${row}`, undefined],
      ] as const) {
        const res = await api(A.guest3, method, path, body, expiredDemo);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe("DEMO_EXPIRED");
      }
      expect(archived(entity, row)).toBe("f");
    }
  });
});

// ---- PostgREST: a browser holding the publishable key and a valid user token talks to the tables directly
function tokenOf(actor: Actor | null): string | null {
  if (!actor) return null;
  const raw = actor.cookie.split("=base64-")[1];
  return (JSON.parse(Buffer.from(raw, "base64url").toString()) as { access_token: string })
    .access_token;
}
async function rest(
  actor: Actor | null,
  method: string,
  table: string,
  query = "",
  body?: unknown,
) {
  const token = tokenOf(actor);
  return fetch(`${server.supabase.apiUrl}/rest/v1/${table}${query}`, {
    method,
    headers: {
      apikey: server.supabase.publishableKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const restInsert = (entity: Entity, org: string, customer: string) =>
  entity.name === "customers"
    ? { organization_id: org, display_name: "M2 rest" }
    : entity.name === "opportunities"
      ? { organization_id: org, customer_id: customer, title: "M2 rest" }
      : { organization_id: org, title: "M2 rest" };

describe("PostgREST with a valid user token: the database refuses what the API refuses", () => {
  it.each(ENTITIES)("$name: reads are scoped to the caller's workspaces", async (entity) => {
    const target = await freshRow(entity);
    for (const who of ["owner", "viewer"]) {
      const rows = await (await rest(A[who], "GET", entity.table, `?id=eq.${target.id}`)).json();
      expect(
        rows.map((r: { id: string }) => r.id),
        who,
      ).toEqual([target.id]);
    }
    for (const who of ["other", "outsider", "guest1", "guest2"]) {
      const res = await rest(A[who], "GET", entity.table, `?id=eq.${target.id}`);
      expect(res.status).toBe(200);
      expect(await res.json(), `${who} sees nothing`).toEqual([]);
    }
    const anon = await rest(null, "GET", entity.table, `?id=eq.${target.id}`);
    expect([401, 403]).toContain(anon.status);
  });
  it.each(ENTITIES)("$name: inserts need a writer of THAT workspace", async (entity) => {
    const before = psql(`select count(*) from public.${entity.table}`);
    const body = (org: string, customer = customerA) => restInsert(entity, org, customer);
    for (const who of ["owner", "admin", "member"])
      expect(
        (await rest(A[who], "POST", entity.table, "", body(orgA))).status,
        `${who} into A`,
      ).toBe(201);
    for (const [who, org] of [
      ["viewer", orgA],
      ["other", orgA],
      ["outsider", orgA],
      ["guest1", orgA],
      ["member", orgB],
      ["guest1", demo2],
      ["guest3", expiredDemo],
    ] as const) {
      const res = await rest(
        A[who],
        "POST",
        entity.table,
        "",
        body(org, org === orgB ? customerB : customerA),
      );
      expect([401, 403], `${who} into ${org}`).toContain(res.status);
    }
    expect([401, 403]).toContain((await rest(null, "POST", entity.table, "", body(orgA))).status);
    expect(Number(psql(`select count(*) from public.${entity.table}`)) - Number(before)).toBe(3);
  });
  it.each(ENTITIES)(
    "$name: updates change only rows the caller may write; deletes are refused for everyone; protected columns cannot move",
    async (entity) => {
      const target = await freshRow(entity);
      const patch = { [entity.textColumn]: "M2 rest patched" };
      for (const who of ["viewer", "other", "outsider", "guest1"]) {
        const res = await rest(A[who], "PATCH", entity.table, `?id=eq.${target.id}`, patch);
        expect(res.status, `${who} update`).toBeLessThan(500);
        expect(await res.json(), `${who} changed no row`).toEqual([]);
      }
      expect(col(entity, target.id)).not.toBe("M2 rest patched");
      expect([401, 403]).toContain(
        (await rest(null, "PATCH", entity.table, `?id=eq.${target.id}`, patch)).status,
      );
      const own = await rest(A.member, "PATCH", entity.table, `?id=eq.${target.id}`, patch);
      expect(own.status).toBe(200);
      expect(col(entity, target.id)).toBe("M2 rest patched");
      for (const who of ["owner", "member", "viewer", "other"]) {
        const res = await rest(A[who], "DELETE", entity.table, `?id=eq.${target.id}`);
        expect([401, 403], `${who} delete`).toContain(res.status);
      }
      expect(psql(`select count(*) from public.${entity.table} where id = '${target.id}'`)).toBe(
        "1",
      );
      for (const change of [{ organization_id: orgB }, { created_by: A.other.id }]) {
        const res = await rest(A.owner, "PATCH", entity.table, `?id=eq.${target.id}`, change);
        expect(res.status, JSON.stringify(change)).toBeGreaterThanOrEqual(400);
      }
      expect(
        psql(
          `select organization_id = '${orgA}' and created_by = '${A.owner.id}' from public.${entity.table} where id = '${target.id}'`,
        ),
      ).toBe("t");
    },
  );
  it("linking across tenants through PostgREST fails on the composite keys", async () => {
    expect(
      (
        await rest(A.member, "POST", "opportunities", "", {
          organization_id: orgA,
          customer_id: customerB,
          title: "link",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await rest(A.member, "POST", "tasks", "", {
          organization_id: orgA,
          customer_id: customerB,
          title: "link",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await rest(A.member, "POST", "tasks", "", {
          organization_id: orgA,
          assigned_to: A.other.id,
          title: "link",
        })
      ).status,
    ).toBe(409);
  });
  it("activity_events: members read their workspace's events only; nobody writes, edits or deletes one", async () => {
    const seen = await (
      await rest(A.viewer, "GET", "activity_events", `?organization_id=eq.${orgA}&limit=5`)
    ).json();
    expect(seen.length).toBeGreaterThan(0);
    expect(
      await (await rest(A.other, "GET", "activity_events", `?organization_id=eq.${orgA}`)).json(),
    ).toEqual([]);
    expect(
      await (await rest(A.guest1, "GET", "activity_events", `?organization_id=eq.${demo2}`)).json(),
    ).toEqual([]);
    expect([401, 403]).toContain((await rest(null, "GET", "activity_events")).status);
    const forged = {
      organization_id: orgA,
      entity_type: "customer",
      entity_id: crypto.randomUUID(),
      action: "created",
      summary: "forged",
    };
    for (const who of ["owner", "member", "viewer", "other"]) {
      expect([401, 403], `${who} insert`).toContain(
        (await rest(A[who], "POST", "activity_events", "", forged)).status,
      );
      expect([401, 403], `${who} update`).toContain(
        (
          await rest(A[who], "PATCH", "activity_events", `?organization_id=eq.${orgA}`, {
            summary: "x",
          })
        ).status,
      );
      expect([401, 403], `${who} delete`).toContain(
        (await rest(A[who], "DELETE", "activity_events", `?organization_id=eq.${orgA}`)).status,
      );
    }
    expect(
      psql(`select count(*) from public.activity_events where summary in ('forged', 'x')`),
    ).toBe("0");
  });
});
