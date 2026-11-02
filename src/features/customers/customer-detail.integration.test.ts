import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** GET/PATCH/DELETE /api/v1/customers/:id and POST /:id/restore, across roles and tenants (PRD 11.3). */
const server = new RealServer();
let owner: Actor,
  admin: Actor,
  member: Actor,
  viewer: Actor,
  outsider: Actor,
  other: Actor,
  guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";
let customerB = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const call = (actor: Actor | null, method: string, path: string, json?: unknown, org = orgA) =>
  server.request(`/api/v1/customers${path}`, actor, { method, json, headers: hdr(org) });
const create = async (actor: Actor, body: Record<string, unknown>, org = orgA) => {
  const res = await call(actor, "POST", "", body, org);
  expect(res.status).toBe(201);
  return (await res.json()).data as { id: string; updatedAt: string; displayName: string };
};
const events = (id: string) =>
  psql(
    `select coalesce(string_agg(action, ',' order by created_at, id), '') from public.activity_events where entity_id = '${id}'`,
  );
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );
const listNames = async (qs = "") =>
  ((await (await call(owner, "GET", qs)).json()).data as Array<{ displayName: string }>).map(
    (c) => c.displayName,
  );

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, other, guest] = await Promise.all([
    server.member("cd-owner"),
    server.member("cd-admin"),
    server.member("cd-member"),
    server.member("cd-viewer"),
    server.member("cd-outsider"),
    server.member("cd-other"),
    server.guest(),
  ]);
  const mk = async (actor: Actor, name: string) => {
    const r = await server.request("/api/v1/organizations", actor, { json: { name } });
    return (await r.json()).data.id as string;
  };
  orgA = await mk(owner, "Detail Co A");
  orgB = await mk(other, "Detail Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  demoOrg = (
    await (await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).json()
  ).data.organizationId;
  customerB = (
    await create(other, { displayName: "Globex Only", email: "boss@globex.example.com" }, orgB)
  ).id;
}, 400_000);
afterAll(() => server.stop());

describe("GET /api/v1/customers/:id", () => {
  it("returns the customer with the counts of related records", async () => {
    const c = await create(owner, {
      displayName: "Detail Subject",
      email: "d@s.example.com",
      tags: ["a"],
    });
    psql(
      `insert into public.opportunities (organization_id, customer_id, title, created_by) select '${orgA}', '${c.id}', 'Deal ' || i, null from generate_series(1, 3) i`,
    );
    psql(
      `insert into public.tasks (organization_id, customer_id, title, created_by) select '${orgA}', '${c.id}', 'Task ' || i, null from generate_series(1, 2) i`,
    );
    const res = await call(viewer, "GET", `/${c.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      id: c.id,
      displayName: "Detail Subject",
      email: "d@s.example.com",
      tags: ["a"],
      archivedAt: null,
      related: { opportunities: 3, tasks: 2, quotes: 0 },
    });
  });
  it("404 for an id that does not exist and for another tenant's customer (the same answer); 400 for a malformed id", async () => {
    const missing = await call(owner, "GET", `/${crypto.randomUUID()}`);
    const foreign = await call(owner, "GET", `/${customerB}`);
    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect((await missing.json()).error.code).toBe((await foreign.json()).error.code);
    expect((await call(owner, "GET", "/not-a-uuid")).status).toBe(400);
    expect((await call(other, "GET", `/${customerB}`, undefined, orgB)).status).toBe(200);
  });
  it("401 signed out; 404 for a workspace the caller is not in", async () => {
    expect((await call(null, "GET", `/${customerB}`)).status).toBe(401);
    expect((await call(outsider, "GET", `/${customerB}`)).status).toBe(404);
  });
  it("a guest reads a seeded customer of their demo, with its related deal count", async () => {
    const list = await (await call(guest, "GET", "?limit=100", undefined, demoOrg)).json();
    const first = list.data[0];
    const res = await call(guest, "GET", `/${first.id}`, undefined, demoOrg);
    expect(res.status).toBe(200);
    expect((await res.json()).data.related.opportunities).toBeGreaterThanOrEqual(0);
  });
});

describe("PATCH /api/v1/customers/:id", () => {
  it("200: updates the given fields, returns the new record and a new updatedAt, and logs one event by the editor", async () => {
    const c = await create(owner, { displayName: "Patch Me", status: "lead" });
    const res = await call(member, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      status: "active",
      companyName: "Patch Co",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body).toMatchObject({
      status: "active",
      companyName: "Patch Co",
      displayName: "Patch Me",
    });
    expect(body.updatedAt).not.toBe(c.updatedAt);
    expect(events(c.id)).toBe("created,updated");
    expect(
      psql(
        `select actor_user_id from public.activity_events where entity_id = '${c.id}' and action = 'updated'`,
      ),
    ).toBe(member.id);
  });

  it("409 with the current version when the copy is stale, and the other person's edit is kept", async () => {
    const c = await create(owner, { displayName: "Stale Target" });
    const first = await call(admin, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      displayName: "Admin Edit",
    });
    expect(first.status).toBe(200);
    const current = (await first.json()).data.updatedAt;
    const second = await call(member, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      displayName: "Member Edit",
    });
    expect(second.status).toBe(409);
    const err = (await second.json()).error;
    expect(err.code).toBe("STALE_EDIT");
    expect(err.meta.current.updatedAt).toBe(current);
    expect(psql(`select display_name from public.customers where id = '${c.id}'`)).toBe(
      "Admin Edit",
    );
    // retrying with the current version works
    expect(
      (
        await call(member, "PATCH", `/${c.id}`, {
          expectedUpdatedAt: current,
          displayName: "Member Edit",
        })
      ).status,
    ).toBe(200);
    expect(psql(`select display_name from public.customers where id = '${c.id}'`)).toBe(
      "Member Edit",
    );
  });

  it("two simultaneous edits from the same starting point: exactly one wins, the other gets 409", async () => {
    const c = await create(owner, { displayName: "Race Target" });
    const [a, b] = await Promise.all([
      call(admin, "PATCH", `/${c.id}`, { expectedUpdatedAt: c.updatedAt, displayName: "Race A" }),
      call(member, "PATCH", `/${c.id}`, { expectedUpdatedAt: c.updatedAt, displayName: "Race B" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? "Race A" : "Race B";
    expect(psql(`select display_name from public.customers where id = '${c.id}'`)).toBe(winner);
    expect(events(c.id)).toBe("created,updated");
  });

  it("a patch that changes nothing is 200, writes no event and keeps updatedAt", async () => {
    const c = await create(owner, { displayName: "Same Same", status: "lead", tags: ["x"] });
    const res = await call(member, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      displayName: "Same Same",
      status: "lead",
      tags: ["x"],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.updatedAt).toBe(c.updatedAt);
    const empty = await call(member, "PATCH", `/${c.id}`, { expectedUpdatedAt: c.updatedAt });
    expect(empty.status).toBe(200);
    expect(events(c.id)).toBe("created");
    expect(
      psql(
        `select updated_at = '${c.updatedAt}'::timestamptz from public.customers where id = '${c.id}'`,
      ),
    ).toBe("t");
  });

  it("a notes-only edit logs that notes changed and never the text", async () => {
    const c = await create(owner, { displayName: "Notes Target" });
    const res = await call(owner, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      notes: "private boiler gossip",
    });
    expect(res.status).toBe(200);
    expect(
      psql(
        `select changes::text from public.activity_events where entity_id = '${c.id}' and action = 'updated'`,
      ),
    ).toBe('{"_content_changed": ["notes"]}');
    expect(
      psql(
        `select count(*) from public.activity_events where changes::text like '%gossip%' or summary like '%gossip%'`,
      ),
    ).toBe("0");
  });

  it("clears optional fields with null or a blank, and unassigns with null", async () => {
    const c = await create(owner, {
      displayName: "Clear Me",
      companyName: "Gone Co",
      phone: "555",
      assignedTo: member.id,
    });
    const res = await call(owner, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      companyName: "",
      phone: null,
      assignedTo: null,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({
      companyName: null,
      phone: null,
      assignedTo: null,
    });
  });

  it("422 for invalid input; unknown and forbidden fields (organization, creator, id) are refused", async () => {
    const c = await create(owner, { displayName: "Validate Me" });
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ displayName: "x" }, "displayName"],
      [{ email: "nope" }, "email"],
      [{ status: "won" }, "status"],
      [{ website: "javascript:alert(1)" }, "website"],
      [{ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "tags"],
      [{ notes: "n".repeat(5001) }, "notes"],
      [{ displayName: "<script>x</script>" }, "displayName"],
    ];
    for (const [patch, field] of bad) {
      const res = await call(owner, "PATCH", `/${c.id}`, {
        expectedUpdatedAt: c.updatedAt,
        ...patch,
      });
      expect(res.status, JSON.stringify(patch)).toBe(422);
      expect(Object.keys((await res.json()).error.fieldErrors)).toContain(field);
    }
    for (const extra of [
      { organizationId: orgB },
      { organization_id: orgB },
      { createdBy: owner.id },
      { created_by: owner.id },
      { id: crypto.randomUUID() },
    ]) {
      expect(
        (await call(owner, "PATCH", `/${c.id}`, { expectedUpdatedAt: c.updatedAt, ...extra }))
          .status,
        JSON.stringify(extra),
      ).toBe(422);
    }
    expect((await call(owner, "PATCH", `/${c.id}`, { displayName: "No Version" })).status).toBe(
      422,
    );
    expect(
      psql(
        `select display_name || organization_id::text from public.customers where id = '${c.id}'`,
      ),
    ).toBe(`Validate Me${orgA}`);
  });

  it("422 when the assignee is not a member of this workspace", async () => {
    const c = await create(owner, { displayName: "Assign Target" });
    const res = await call(owner, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      assignedTo: other.id,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_REFERENCE");
  });

  it("a changed e-mail that another customer uses returns a warning, not an error", async () => {
    await create(owner, { displayName: "Holder", email: "shared@detail.example.com" });
    const c = await create(owner, { displayName: "Changer" });
    const res = await call(owner, "PATCH", `/${c.id}`, {
      expectedUpdatedAt: c.updatedAt,
      email: "  SHARED@Detail.example.com ",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).meta.warnings).toEqual([
      expect.objectContaining({ code: "DUPLICATE_EMAIL", field: "email" }),
    ]);
  });

  it("403 for a viewer, 404 for another tenant's customer or workspace, 401 signed out, and nothing changes", async () => {
    const c = await create(owner, { displayName: "Guarded" });
    const body = { expectedUpdatedAt: c.updatedAt, displayName: "Hacked" };
    expect((await call(viewer, "PATCH", `/${c.id}`, body)).status).toBe(403);
    expect((await call(other, "PATCH", `/${c.id}`, body, orgB)).status).toBe(404);
    expect((await call(owner, "PATCH", `/${customerB}`, body)).status).toBe(404);
    expect((await call(outsider, "PATCH", `/${c.id}`, body)).status).toBe(404);
    expect((await call(null, "PATCH", `/${c.id}`, body)).status).toBe(401);
    expect(psql(`select display_name from public.customers where id = '${c.id}'`)).toBe("Guarded");
    expect(psql(`select display_name from public.customers where id = '${customerB}'`)).toBe(
      "Globex Only",
    );
  });
});

describe("DELETE (archive) and POST /restore", () => {
  it("archive returns 204, the customer leaves the default list and stays readable, restore brings it back", async () => {
    const c = await create(owner, { displayName: "Archive Me" });
    expect(await listNames("?q=archive me")).toEqual(["Archive Me"]);
    const del = await call(member, "DELETE", `/${c.id}`);
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    expect(await listNames("?q=archive me")).toEqual([]);
    expect(await listNames("?q=archive me&archived=true")).toEqual(["Archive Me"]);
    const read = await call(owner, "GET", `/${c.id}`);
    expect((await read.json()).data.archivedAt).not.toBeNull();
    const restored = await call(admin, "POST", `/${c.id}/restore`);
    expect(restored.status).toBe(200);
    expect((await restored.json()).data).toMatchObject({ id: c.id, archivedAt: null });
    expect(await listNames("?q=archive me")).toEqual(["Archive Me"]);
    expect(events(c.id)).toBe("created,archived,restored");
  });

  it("is idempotent: archiving twice and restoring an active customer are successes with no extra events", async () => {
    const c = await create(owner, { displayName: "Idempotent One" });
    expect((await call(owner, "DELETE", `/${c.id}`)).status).toBe(204);
    expect((await call(owner, "DELETE", `/${c.id}`)).status).toBe(204);
    expect(events(c.id)).toBe("created,archived");
    expect((await call(owner, "POST", `/${c.id}/restore`)).status).toBe(200);
    expect((await call(owner, "POST", `/${c.id}/restore`)).status).toBe(200);
    expect(events(c.id)).toBe("created,archived,restored");
  });

  it("nothing is ever hard-deleted, and an archived customer keeps its deals", async () => {
    const c = await create(owner, { displayName: "Has Deals" });
    psql(
      `insert into public.opportunities (organization_id, customer_id, title, created_by) values ('${orgA}', '${c.id}', 'Keep Me', null)`,
    );
    expect((await call(owner, "DELETE", `/${c.id}`)).status).toBe(204);
    expect(psql(`select count(*) from public.customers where id = '${c.id}'`)).toBe("1");
    expect(psql(`select count(*) from public.opportunities where customer_id = '${c.id}'`)).toBe(
      "1",
    );
    const read = await (await call(owner, "GET", `/${c.id}`)).json();
    expect(read.data.related.opportunities).toBe(1);
  });

  it("403 for a viewer, 404 for another tenant, 401 signed out, 400 for a bad id", async () => {
    const c = await create(owner, { displayName: "Protected Archive" });
    expect((await call(viewer, "DELETE", `/${c.id}`)).status).toBe(403);
    expect((await call(viewer, "POST", `/${c.id}/restore`)).status).toBe(403);
    expect((await call(other, "DELETE", `/${c.id}`, undefined, orgB)).status).toBe(404);
    expect((await call(owner, "DELETE", `/${customerB}`)).status).toBe(404);
    expect((await call(owner, "POST", `/${customerB}/restore`)).status).toBe(404);
    expect((await call(null, "DELETE", `/${c.id}`)).status).toBe(401);
    expect((await call(owner, "DELETE", "/nope")).status).toBe(400);
    expect(psql(`select archived_at is null from public.customers where id = '${c.id}'`)).toBe("t");
    expect(psql(`select archived_at is null from public.customers where id = '${customerB}'`)).toBe(
      "t",
    );
  });
});

describe("an expired demo", () => {
  it("refuses every mutation with the expiry error and changes nothing", async () => {
    const list = await (await call(guest, "GET", "?limit=1", undefined, demoOrg)).json();
    const target = list.data[0] as { id: string; updatedAt: string; displayName: string };
    psql(
      `update public.organizations set expires_at = now() - interval '1 minute' where id = '${demoOrg}'`,
    );
    for (const [method, path, body] of [
      ["PATCH", `/${target.id}`, { expectedUpdatedAt: target.updatedAt, displayName: "Too Late" }],
      ["DELETE", `/${target.id}`, undefined],
      ["POST", `/${target.id}/restore`, undefined],
      ["POST", "", { displayName: "Too Late Either" }],
    ] as const) {
      const res = await call(guest, method, path, body, demoOrg);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error.code).toBe("DEMO_EXPIRED");
    }
    expect(psql(`select display_name from public.customers where id = '${target.id}'`)).toBe(
      target.displayName,
    );
    expect(psql(`select count(*) from public.customers where display_name like 'Too Late%'`)).toBe(
      "0",
    );
  });
});
