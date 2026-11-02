import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-253] The task API's contract against the real production build and Supabase: every route's status codes and envelope,
 * complete / reopen idempotency and the exact activity events, no duplicate events for no-op writes, cross-tenant references,
 * and the overdue filter compared with an independent SQL query in nine time zones.
 */
const server = new RealServer();
let owner: Actor, admin: Actor, viewer: Actor, outsider: Actor, other: Actor, guest: Actor;
let org = "";
let orgB = "";
let customerB = "";
let dealB = "";
let demo = "";

const hdr = (o: string) => ({ "X-Organization-Id": o });
const api = (actor: Actor | null, method: string, path: string, json?: unknown, o = org) =>
  server.request(`/api/v1/tasks${path}`, actor, { method, json, headers: hdr(o) });
const errorOf = async (res: Response) =>
  (await res.json()).error as {
    code: string;
    message: string;
    requestId: string;
    fieldErrors?: Record<string, string[]>;
    meta?: { current?: { updatedAt: string } };
  };
const events = (id: string) =>
  psql(
    `select coalesce(string_agg(action, ',' order by created_at, id), '') from public.activity_events where entity_id = '${id}' and action <> 'created'`,
  );
const make = async (title: string, extra: Record<string, unknown> = {}) =>
  (await (await api(owner, "POST", "", { title, ...extra })).json()).data as {
    id: string;
    updatedAt: string;
    status: string;
  };

beforeAll(async () => {
  await server.start();
  [owner, admin, viewer, outsider, other, guest] = await Promise.all([
    server.member("tc-owner"),
    server.member("tc-admin"),
    server.member("tc-viewer"),
    server.member("tc-outsider"),
    server.member("tc-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const res = await server.request("/api/v1/organizations", actor, { json: { name } });
    expect(res.status).toBe(201);
    return (await res.json()).data.id as string;
  };
  org = await mk(owner, "Task Contract Co");
  orgB = await mk(other, "Task Contract Other");
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${admin.id}', 'admin'), ('${org}', '${viewer.id}', 'viewer')`,
  );
  const cust = async (actor: Actor, o: string, displayName: string) =>
    (
      await (
        await server.request("/api/v1/customers", actor, { json: { displayName }, headers: hdr(o) })
      ).json()
    ).data.id as string;
  await cust(owner, org, "Contract Customer");
  customerB = await cust(other, orgB, "Other Customer");
  dealB = (
    await (
      await server.request("/api/v1/opportunities", other, {
        json: { customerId: customerB, title: "Other deal" },
        headers: hdr(orgB),
      })
    ).json()
  ).data.id;
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demo = (await boot.json()).data.organizationId;
}, 600_000);
afterAll(() => server.stop());

describe("status codes and envelopes of every task route", () => {
  let target: { id: string; updatedAt: string };
  beforeAll(async () => {
    target = await make("Contract target");
  });
  const ROUTES = (): Array<[string, string, string, unknown]> => [
    ["list", "GET", "", undefined],
    ["create", "POST", "", { title: "Route probe" }],
    ["get", "GET", `/${target.id}`, undefined],
    [
      "patch",
      "PATCH",
      `/${target.id}`,
      { title: "Route probe", expectedUpdatedAt: target.updatedAt },
    ],
    ["archive", "DELETE", `/${target.id}`, undefined],
    [
      "complete",
      "POST",
      `/${target.id}/complete`,
      { completed: true, expectedUpdatedAt: target.updatedAt },
    ],
  ];

  it("success: { data, meta } for items and lists (201 on create, 204 and an empty body on archive)", async () => {
    const created = await api(owner, "POST", "", { title: "Envelope" });
    expect(created.status).toBe(201);
    expect(Object.keys(await created.json()).sort()).toEqual(["data", "meta"]);
    const list = await (await api(owner, "GET", "?limit=1")).json();
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.meta).toMatchObject({ page: 1, limit: 1 });
    const one = await api(owner, "GET", `/${target.id}`);
    expect(Object.keys(await one.json()).sort()).toEqual(["data", "meta"]);
    const gone = await make("To archive");
    const del = await api(owner, "DELETE", `/${gone.id}`);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
  });
  it("401 UNAUTHENTICATED on every route when signed out", async () => {
    for (const [name, method, path, json] of ROUTES()) {
      const res = await api(null, method, path, json);
      expect(res.status, name).toBe(401);
      expect((await errorOf(res)).code, name).toBe("UNAUTHENTICATED");
    }
  });
  it("403 FORBIDDEN for a viewer on every write route, with nothing changed; reads are allowed", async () => {
    expect((await api(viewer, "GET", "")).status).toBe(200);
    expect((await api(viewer, "GET", `/${target.id}`)).status).toBe(200);
    const before = psql(
      `select updated_at::text || status || coalesce(archived_at::text, '') from public.tasks where id = '${target.id}'`,
    );
    const count = psql(`select count(*) from public.tasks where organization_id = '${org}'`);
    for (const [name, method, path, json] of ROUTES().filter(([n]) =>
      ["create", "patch", "archive", "complete"].includes(n),
    )) {
      const res = await api(viewer, method, path, json);
      expect(res.status, name).toBe(403);
      expect((await errorOf(res)).code, name).toBe("FORBIDDEN");
    }
    expect(
      psql(
        `select updated_at::text || status || coalesce(archived_at::text, '') from public.tasks where id = '${target.id}'`,
      ),
    ).toBe(before);
    expect(psql(`select count(*) from public.tasks where organization_id = '${org}'`)).toBe(count);
  });
  it("404 for non-members and for another tenant's task (the same code as a missing one) on every id route", async () => {
    const missing = await errorOf(await api(owner, "GET", `/${crypto.randomUUID()}`));
    for (const [name, method, path, json] of ROUTES().filter(
      ([n]) => n !== "list" && n !== "create",
    )) {
      const res = await api(other, method, path, json, orgB);
      expect(res.status, name).toBe(404);
      expect((await errorOf(res)).code, name).toBe(missing.code);
    }
    for (const actor of [outsider, other]) {
      expect((await api(actor, "GET", "")).status).toBe(404);
      expect((await api(actor, "POST", "", { title: "Nope" })).status).toBe(404);
    }
    expect(psql(`select count(*) from public.tasks where organization_id = '${orgB}'`)).toBe("0");
  });
  it("404 for another tenant's customer or opportunity, 422 for an assignee outside the workspace; nothing is written", async () => {
    const before = psql(`select count(*) from public.tasks`);
    for (const [body, code, status] of [
      [{ title: "x1", customerId: customerB }, "CUSTOMER_NOT_FOUND", 404],
      [{ title: "x2", opportunityId: dealB }, "OPPORTUNITY_NOT_FOUND", 404],
      [{ title: "x3", customerId: crypto.randomUUID() }, "CUSTOMER_NOT_FOUND", 404],
      [{ title: "x4", assignedTo: other.id }, undefined, 422],
      [{ title: "x5", assignedTo: outsider.id }, undefined, 422],
    ] as const) {
      const res = await api(owner, "POST", "", body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      if (code) expect((await errorOf(res)).code).toBe(code);
    }
    expect(
      (
        await api(owner, "PATCH", `/${target.id}`, {
          customerId: customerB,
          expectedUpdatedAt: target.updatedAt,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(owner, "PATCH", `/${target.id}`, {
          opportunityId: dealB,
          expectedUpdatedAt: target.updatedAt,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api(owner, "PATCH", `/${target.id}`, {
          assignedTo: other.id,
          expectedUpdatedAt: target.updatedAt,
        })
      ).status,
    ).toBe(422);
    expect(psql(`select count(*) from public.tasks`)).toBe(before);
  });
  it("400 for a malformed id on every id route", async () => {
    for (const [method, suffix, json] of [
      ["GET", "", undefined],
      ["PATCH", "", { title: "x y", expectedUpdatedAt: target.updatedAt }],
      ["DELETE", "", undefined],
      ["POST", "/complete", { completed: true, expectedUpdatedAt: target.updatedAt }],
    ] as const)
      expect(
        (await api(owner, method, `/not-a-uuid${suffix}`, json)).status,
        `${method} ${suffix}`,
      ).toBe(400);
  });
  it("409 STALE_EDIT carries the current version for PATCH and for complete, and nothing is overwritten", async () => {
    const t = await make("Stale subject");
    const next = (
      await (
        await api(owner, "PATCH", `/${t.id}`, {
          title: "Fresh title",
          expectedUpdatedAt: t.updatedAt,
        })
      ).json()
    ).data;
    for (const [path, method, json] of [
      [`/${t.id}`, "PATCH", { title: "Stale title", expectedUpdatedAt: t.updatedAt }],
      [`/${t.id}/complete`, "POST", { completed: true, expectedUpdatedAt: t.updatedAt }],
    ] as const) {
      const res = await api(admin, method, path, json);
      expect(res.status, path).toBe(409);
      const e = await errorOf(res);
      expect(e.code).toBe("STALE_EDIT");
      expect(e.meta?.current?.updatedAt).toBe(next.updatedAt);
    }
    expect(psql(`select title || '|' || status from public.tasks where id = '${t.id}'`)).toBe(
      "Fresh title|todo",
    );
  });
  it("422 with the offending field for each invalid input; the database-owned completedAt cannot be sent", async () => {
    for (const [json, field] of [
      [{ title: "x" }, "title"],
      [{ title: "t".repeat(161) }, "title"],
      [{ title: "Valid title", description: "d".repeat(5001) }, "description"],
      [{ title: "Valid title", dueDate: "2026-02-30" }, "dueDate"],
      [{ title: "Valid title", status: "open" }, "status"],
      [{ title: "Valid title", priority: "critical" }, "priority"],
    ] as const) {
      const res = await api(owner, "POST", "", json);
      expect(res.status, JSON.stringify(json)).toBe(422);
      expect(Object.keys((await errorOf(res)).fieldErrors ?? {})).toContain(field);
    }
    for (const forged of [
      { completedAt: "2001-01-01T00:00:00Z" },
      { organizationId: orgB },
      { createdBy: admin.id },
    ])
      expect((await api(owner, "POST", "", { title: "Forged", ...forged })).status).toBe(422);
    expect(
      (await api(owner, "POST", `/${target.id}/complete`, { expectedUpdatedAt: target.updatedAt }))
        .status,
    ).toBe(422);
    expect(
      (
        await api(owner, "POST", `/${target.id}/complete`, {
          completed: "yes",
          expectedUpdatedAt: target.updatedAt,
        })
      ).status,
    ).toBe(422);
  });
  it("429 DEMO_CAP on the 76th demo task, with a message free of SQL words and nothing written", async () => {
    const have = Number(
      psql(`select count(*) from public.tasks where organization_id = '${demo}'`),
    );
    psql(
      `insert into public.tasks (organization_id, title) select '${demo}', 'Fill ' || i from generate_series(1, ${75 - have}) i`,
    );
    expect(psql(`select count(*) from public.tasks where organization_id = '${demo}'`)).toBe("75");
    const res = await api(guest, "POST", "", { title: "Over the cap" }, demo);
    expect(res.status).toBe(429);
    const e = await errorOf(res);
    expect(e.code).toBe("DEMO_CAP");
    expect(e.message).not.toMatch(/relation|constraint|tasks_|postgres|select |insert /i);
    expect(psql(`select count(*) from public.tasks where organization_id = '${demo}'`)).toBe("75");
  });
  it("errors never leak SQL, stack traces or other tenants' ids, and every one has a request id", async () => {
    const samples = [
      await api(owner, "GET", `/${crypto.randomUUID()}`),
      await api(viewer, "POST", "", { title: "Viewer" }),
      await api(owner, "POST", "", { title: "Leak", customerId: customerB }),
      await api(owner, "POST", "", { title: "x" }),
      await api(null, "GET", ""),
    ];
    for (const res of samples) {
      const text = JSON.stringify(await res.json());
      expect(text).toMatch(/"requestId":"[^"]+"/);
      expect(text).not.toMatch(
        /stack|at .*\.ts|postgres|SQLSTATE|violates|pg_|public\.|constraint/i,
      );
      expect(text).not.toContain(customerB);
      expect(text).not.toContain(orgB);
    }
  });
});

describe("complete / reopen are idempotent and log exactly the events they should", () => {
  it("complete then reopen yields exactly two events; repeating either call yields none and keeps the version", async () => {
    const t = await make("Idempotent");
    const done = (
      await (
        await api(admin, "POST", `/${t.id}/complete`, {
          completed: true,
          expectedUpdatedAt: t.updatedAt,
        })
      ).json()
    ).data;
    expect(events(t.id)).toBe("completed");
    for (let i = 0; i < 3; i++) {
      const again = await api(admin, "POST", `/${t.id}/complete`, {
        completed: true,
        expectedUpdatedAt: done.updatedAt,
      });
      expect(again.status).toBe(200);
      expect((await again.json()).data.updatedAt).toBe(done.updatedAt);
    }
    expect(events(t.id)).toBe("completed");
    const reopened = (
      await (
        await api(admin, "POST", `/${t.id}/complete`, {
          completed: false,
          expectedUpdatedAt: done.updatedAt,
        })
      ).json()
    ).data;
    expect(reopened).toMatchObject({ status: "todo", completedAt: null });
    for (let i = 0; i < 3; i++) {
      const again = await api(admin, "POST", `/${t.id}/complete`, {
        completed: false,
        expectedUpdatedAt: reopened.updatedAt,
      });
      expect(again.status).toBe(200);
      expect((await again.json()).data.updatedAt).toBe(reopened.updatedAt);
    }
    expect(events(t.id)).toBe("completed,reopened");
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${t.id}' and action in ('completed', 'reopened') and actor_user_id = '${admin.id}'`,
      ),
    ).toBe("2");
  });
  it("completing sets a completion time near now; reopening clears it; a reopened task can be put back to in progress or blocked", async () => {
    const t = await make("Times");
    const done = (
      await (
        await api(owner, "POST", `/${t.id}/complete`, {
          completed: true,
          expectedUpdatedAt: t.updatedAt,
        })
      ).json()
    ).data;
    expect(Date.now() - new Date(done.completedAt).getTime()).toBeLessThan(60_000);
    for (const status of ["in_progress", "blocked"] as const) {
      const re = (
        await (
          await api(owner, "POST", `/${t.id}/complete`, {
            completed: false,
            status,
            expectedUpdatedAt: done.updatedAt,
          })
        ).json()
      ).data;
      expect(re).toMatchObject({ status, completedAt: null });
      const d2 = (
        await (
          await api(owner, "POST", `/${t.id}/complete`, {
            completed: true,
            expectedUpdatedAt: re.updatedAt,
          })
        ).json()
      ).data;
      done.updatedAt = d2.updatedAt;
    }
  });
  it("no duplicate events for no-op writes: a PATCH that changes nothing, a repeat of the same values, a status set to its current value", async () => {
    const t = await make("No-ops", {
      description: "same",
      priority: "high",
      dueDate: "2027-01-01",
    });
    const before = events(t.id);
    const same = await api(owner, "PATCH", `/${t.id}`, {
      title: "No-ops",
      description: "same",
      priority: "high",
      dueDate: "2027-01-01",
      status: "todo",
      expectedUpdatedAt: t.updatedAt,
    });
    expect(same.status).toBe(200);
    expect((await same.json()).data.updatedAt).toBe(t.updatedAt);
    expect(events(t.id)).toBe(before);
    const real = (
      await (
        await api(owner, "PATCH", `/${t.id}`, {
          priority: "urgent",
          expectedUpdatedAt: t.updatedAt,
        })
      ).json()
    ).data;
    expect(events(t.id)).toBe("updated");
    const again = await api(owner, "PATCH", `/${t.id}`, {
      priority: "urgent",
      expectedUpdatedAt: real.updatedAt,
    });
    expect(again.status).toBe(200);
    expect(events(t.id)).toBe("updated");
  });
  it("two simultaneous completes from the same version: one performs it, the other is 409 or the idempotent 200, and there is exactly one completed event", async () => {
    const t = await make("Race");
    const [a, b] = await Promise.all([
      api(owner, "POST", `/${t.id}/complete`, { completed: true, expectedUpdatedAt: t.updatedAt }),
      api(admin, "POST", `/${t.id}/complete`, { completed: true, expectedUpdatedAt: t.updatedAt }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(events(t.id)).toBe("completed");
  });
});

describe("the overdue filter equals independent SQL in nine time zones (real clock, dates around today)", () => {
  const ZONES = [
    "UTC",
    "America/New_York",
    "Europe/London",
    "Australia/Lord_Howe",
    "Asia/Kolkata",
    "Pacific/Kiritimati",
    "Pacific/Apia",
    "Pacific/Pago_Pago",
    "America/Los_Angeles",
  ];
  it("for every zone: the API's overdue ids and its dueToday flags equal what `(now() at time zone tz)::date` says", async () => {
    const zoneOrg = await (async () => {
      const res = await server.request("/api/v1/organizations", owner, {
        json: { name: "Zone Parity Co" },
      });
      return (await res.json()).data.id as string;
    })();
    // due dates from three days ago to three days ahead, in several statuses, plus undated and done
    psql(`
      insert into public.tasks (organization_id, title, status, due_date, completed_at)
      select '${zoneOrg}', 'Zone ' || d || ' ' || s, s, (now() at time zone 'utc')::date + d, case when s = 'done' then now() end
      from generate_series(-3, 3) d cross join (values ('todo'), ('in_progress'), ('blocked'), ('done')) v(s)`);
    psql(`insert into public.tasks (organization_id, title) values ('${zoneOrg}', 'Zone undated')`);
    for (const zone of ZONES) {
      psql(`update public.organizations set timezone = '${zone}' where id = '${zoneOrg}'`);
      const sqlOverdue = psql(
        `select coalesce(string_agg(id::text, ',' order by id), '') from public.tasks t where organization_id = '${zoneOrg}' and status <> 'done' and due_date < (now() at time zone '${zone}')::date`,
      );
      const sqlToday = psql(
        `select coalesce(string_agg(id::text, ',' order by id), '') from public.tasks t where organization_id = '${zoneOrg}' and status <> 'done' and due_date = (now() at time zone '${zone}')::date`,
      );
      const res = await (
        await api(owner, "GET", "?limit=100&overdue=true", undefined, zoneOrg)
      ).json();
      expect(
        res.data
          .map((t: { id: string }) => t.id)
          .sort()
          .join(","),
        `${zone} overdue filter`,
      ).toBe(sqlOverdue);
      const all = (await (await api(owner, "GET", "?limit=100", undefined, zoneOrg)).json())
        .data as Array<{ id: string; dueToday: boolean; dueState: string; status: string }>;
      expect(
        all
          .filter((t) => t.dueToday)
          .map((t) => t.id)
          .sort()
          .join(","),
        `${zone} dueToday flags`,
      ).toBe(sqlToday);
      expect(
        all
          .filter((t) => t.dueState === "overdue")
          .map((t) => t.id)
          .sort()
          .join(","),
        `${zone} overdue flags`,
      ).toBe(sqlOverdue);
      expect(
        all.every((t) => (t.status === "done") === (t.dueState === "done")),
        `${zone} done tasks`,
      ).toBe(true);
    }
  });
});
