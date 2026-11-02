import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * /api/v1/invitations and /api/v1/members over real HTTP (production build, local Supabase), across roles and tenants
 * (SIT-224, PRD 11.3).
 */
const server = new RealServer();
let owner: Actor, admin: Actor, member: Actor, viewer: Actor, outsider: Actor, other: Actor;
let joiner: Actor, joiner2: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";

const hdr = (org: string) => ({ "X-Organization-Id": org });
const call = (
  actor: Actor | null,
  method: string,
  path: string,
  json?: unknown,
  org: string | null = orgA,
) =>
  server.request(`/api/v1${path}`, actor, {
    method,
    json,
    headers: org ? hdr(org) : undefined,
  });
const code = async (res: Response) => ((await res.json()).error?.code ?? null) as string | null;
const invite = (actor: Actor, email: string, role = "member") =>
  call(actor, "POST", "/invitations", { email, role });
async function tokenFor(actor: Actor, email: string, role = "member"): Promise<string> {
  const res = await invite(actor, email, role);
  expect(res.status).toBe(201);
  return (await res.json()).data.token as string;
}
const accept = (actor: Actor | null, token: string) =>
  call(actor, "POST", "/invitations/accept", { token }, null);
const roleOf = (org: string, user: Actor) =>
  psql(
    `select coalesce((select role from public.memberships where organization_id = '${org}' and user_id = '${user.id}'), 'none')`,
  );
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, outsider, other, joiner, joiner2, guest] = await Promise.all([
    server.member("mb-owner"),
    server.member("mb-admin"),
    server.member("mb-member"),
    server.member("mb-viewer"),
    server.member("mb-outsider"),
    server.member("mb-other"),
    server.member("mb-joiner"),
    server.member("mb-joiner2"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Members Co A");
  orgB = await createOrg(other, "Members Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  expect(boot.status).toBe(200);
  demoOrg = (await boot.json()).data.organizationId;
}, 400_000);

afterAll(() => server.stop());

describe("POST /api/v1/invitations", () => {
  it("201: an owner invites, and the response carries the one-time token and link", async () => {
    const res = await invite(owner, "  New.Person@Example.test ", "viewer");
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.token).toMatch(/^[0-9a-f]{64}$/);
    expect(data.link).toBe(`${server.base}/invite#token=${data.token}`);
    expect(data).toMatchObject({ email: "new.person@example.test", role: "viewer" });
    expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    // only the hash is stored
    expect(psql(`select count(*) from public.invitations where token_hash = '${data.token}'`)).toBe(
      "0",
    );
  });

  it("201: an admin can invite an admin, a member and a viewer", async () => {
    for (const [i, role] of ["admin", "member", "viewer"].entries()) {
      expect((await invite(admin, `by-admin-${i}@example.test`, role)).status).toBe(201);
    }
  });

  it("422: an owner invitation, an unknown role, a bad address and extra fields are refused", async () => {
    for (const body of [
      { email: "x@example.test", role: "owner" },
      { email: "x@example.test", role: "root" },
      { email: "not-an-address", role: "member" },
      { email: "x@example.test", role: "member", organizationId: orgB },
      { role: "member" },
    ]) {
      expect((await call(owner, "POST", "/invitations", body)).status, JSON.stringify(body)).toBe(
        422,
      );
    }
  });

  it("409: an open invitation for the address already exists, and an existing member cannot be invited", async () => {
    expect((await invite(owner, "dup@example.test")).status).toBe(201);
    const again = await invite(owner, "DUP@example.test");
    expect(again.status).toBe(409);
    const existing = await invite(owner, member.email!);
    expect(existing.status).toBe(409);
    expect(await code(existing)).toBe("ALREADY_MEMBER");
  });

  it("403: members, viewers and a demo guest cannot invite; a non-member gets 404", async () => {
    expect((await invite(member, "m@example.test")).status).toBe(403);
    expect((await invite(viewer, "v@example.test")).status).toBe(403);
    const g = await call(
      guest,
      "POST",
      "/invitations",
      { email: "g@example.test", role: "member" },
      demoOrg,
    );
    expect(g.status).toBe(403);
    expect((await invite(outsider, "o@example.test")).status).toBe(404);
    expect(await code(await invite(other, "o@example.test"))).toBe("ORG_NOT_FOUND");
  });

  it("401: signed out", async () => {
    expect((await invite(null as unknown as Actor, "x@example.test")).status).toBe(401);
  });
});

describe("GET /api/v1/invitations and DELETE /api/v1/invitations/:id", () => {
  it("lists open invitations without any token data, for an owner and an admin only", async () => {
    const res = await call(owner, "GET", "/invitations");
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.data.length).toBeGreaterThan(0);
    expect(Object.keys(body.data[0]).sort()).toEqual(
      ["createdAt", "email", "expired", "expiresAt", "id", "invitedBy", "role"].sort(),
    );
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect((await call(admin, "GET", "/invitations")).status).toBe(200);
    for (const who of [member, viewer]) {
      expect((await call(who, "GET", "/invitations")).status).toBe(403);
    }
    expect((await call(guest, "GET", "/invitations", undefined, demoOrg)).status).toBe(403);
    expect((await call(outsider, "GET", "/invitations")).status).toBe(404);
  });

  it("does not list another workspace's invitations", async () => {
    expect((await invite(other, "only-in-b@example.test")).status).toBe(404); // other is not in A
    expect(
      (
        await call(
          other,
          "POST",
          "/invitations",
          { email: "only-in-b@example.test", role: "member" },
          orgB,
        )
      ).status,
    ).toBe(201);
    const list = (await (await call(owner, "GET", "/invitations")).json()).data as Array<{
      email: string;
    }>;
    expect(list.some((i) => i.email === "only-in-b@example.test")).toBe(false);
  });

  it("revokes (204, idempotent); a member cannot; another workspace's owner gets 404; a bad id is 400", async () => {
    const made = await (await invite(owner, "to-revoke@example.test")).json();
    const id = made.data.id as string;
    expect((await call(member, "DELETE", `/invitations/${id}`)).status).toBe(403);
    expect((await call(other, "DELETE", `/invitations/${id}`, undefined, orgB)).status).toBe(404);
    expect((await call(admin, "DELETE", `/invitations/${id}`)).status).toBe(204);
    expect((await call(owner, "DELETE", `/invitations/${id}`)).status).toBe(204);
    expect((await call(owner, "DELETE", "/invitations/not-a-uuid")).status).toBe(400);
    const list = (await (await call(owner, "GET", "/invitations")).json()).data as Array<{
      id: string;
    }>;
    expect(list.some((i) => i.id === id)).toBe(false);
  });
});

describe("POST /api/v1/invitations/accept", () => {
  it("200: the matching verified user joins with the invited role, and a second use is 409 INVITATION_USED", async () => {
    const token = await tokenFor(owner, joiner.email!, "member");
    const res = await accept(joiner, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ organizationId: orgA, role: "member" });
    expect(JSON.stringify(body)).not.toContain(token);
    expect(roleOf(orgA, joiner)).toBe("member");
    const again = await accept(joiner, token);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("INVITATION_USED");
  });

  it("403 EMAIL_MISMATCH for someone else's token; the invitation stays usable by the right person", async () => {
    const token = await tokenFor(owner, joiner2.email!, "viewer");
    const wrong = await accept(outsider, token);
    expect(wrong.status).toBe(403);
    expect(await code(wrong)).toBe("EMAIL_MISMATCH");
    expect(roleOf(orgA, outsider)).toBe("none");
    expect((await accept(joiner2, token)).status).toBe(200);
    expect(roleOf(orgA, joiner2)).toBe("viewer");
  });

  it("404 INVITATION_INVALID for an unknown or malformed token", async () => {
    for (const t of ["0".repeat(64), "nope", "A".repeat(64)]) {
      const res = await accept(outsider, t);
      expect(res.status, t).toBe(404);
      expect(await code(res)).toBe("INVITATION_INVALID");
    }
  });

  it("409 INVITATION_REVOKED and INVITATION_EXPIRED", async () => {
    const email = `rv-${Date.now()}@example.test`;
    const made = await (await invite(owner, email)).json();
    await call(owner, "DELETE", `/invitations/${made.data.id}`);
    const user = await server.member("mb-late");
    psql(`update auth.users set email = '${email}' where id = '${user.id}'`);
    const revoked = await accept(user, made.data.token);
    expect(revoked.status).toBe(409);
    expect(await code(revoked)).toBe("INVITATION_REVOKED");

    const email2 = `ex-${Date.now()}@example.test`;
    const made2 = await (await invite(owner, email2)).json();
    psql(
      `alter table public.invitations disable trigger invitations_protect_columns; update public.invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = '${made2.data.id}'; alter table public.invitations enable trigger invitations_protect_columns`,
    );
    psql(`update auth.users set email = '${email2}' where id = '${user.id}'`);
    const expired = await accept(user, made2.data.token);
    expect(expired.status).toBe(409);
    expect(await code(expired)).toBe("INVITATION_EXPIRED");
  });

  it("403 EMAIL_UNVERIFIED when the address is not confirmed", async () => {
    const user = await server.member("mb-unverified");
    const token = await tokenFor(owner, user.email!, "member");
    psql(`update auth.users set email_confirmed_at = null where id = '${user.id}'`);
    const res = await accept(user, token);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("EMAIL_UNVERIFIED");
  });

  it("403 for a demo guest, 401 signed out, 422 for a missing token", async () => {
    expect((await accept(guest, "0".repeat(64))).status).toBe(403);
    expect((await accept(null, "0".repeat(64))).status).toBe(401);
    expect((await call(outsider, "POST", "/invitations/accept", {}, null)).status).toBe(422);
  });

  it("429 RATE_LIMITED after repeated failed attempts, which are counted", async () => {
    const user = await server.member("mb-guesser");
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await accept(user, String(i).repeat(64).slice(0, 64))).status;
    expect(last).toBe(429);
    const res = await accept(user, "f".repeat(64));
    expect(res.status).toBe(429);
    expect(await code(res)).toBe("RATE_LIMITED");
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});

describe("PATCH and DELETE /api/v1/members/:userId", () => {
  it("members and viewers cannot change roles or remove anyone (403), nor can a guest; a non-member gets 404", async () => {
    for (const who of [member, viewer]) {
      expect((await call(who, "PATCH", `/members/${viewer.id}`, { role: "admin" })).status).toBe(
        403,
      );
      expect((await call(who, "DELETE", `/members/${viewer.id}`)).status).toBe(403);
    }
    expect(
      (await call(guest, "PATCH", `/members/${guest.id}`, { role: "owner" }, demoOrg)).status,
    ).toBe(403);
    expect((await call(outsider, "PATCH", `/members/${viewer.id}`, { role: "admin" })).status).toBe(
      404,
    );
    expect((await call(other, "DELETE", `/members/${viewer.id}`, undefined, orgB)).status).toBe(
      404,
    );
    expect(roleOf(orgA, viewer)).toBe("viewer");
  });

  it("an admin cannot make an owner, touch an owner or promote themselves", async () => {
    for (const [target, body, want] of [
      [admin.id, { role: "owner" }, "OWNER_GRANT"],
      [member.id, { role: "owner" }, "OWNER_GRANT"],
      [owner.id, { role: "member" }, "OWNER_PROTECTED"],
    ] as const) {
      const res = await call(admin, "PATCH", `/members/${target}`, body);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe(want);
    }
    const del = await call(admin, "DELETE", `/members/${owner.id}`);
    expect(del.status).toBe(403);
    expect(roleOf(orgA, owner)).toBe("owner");
    expect(roleOf(orgA, admin)).toBe("admin");
  });

  it("409 LAST_OWNER: the only owner cannot be demoted or removed", async () => {
    const demote = await call(owner, "PATCH", `/members/${owner.id}`, { role: "admin" });
    expect(demote.status).toBe(409);
    expect(await code(demote)).toBe("LAST_OWNER");
    const remove = await call(owner, "DELETE", `/members/${owner.id}`);
    expect(remove.status).toBe(409);
    expect(roleOf(orgA, owner)).toBe("owner");
  });

  it("an owner changes a role (200), makes a second owner, and removes a member (204)", async () => {
    const res = await call(owner, "PATCH", `/members/${member.id}`, { role: "admin" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ userId: member.id, role: "admin" });
    expect((await call(admin, "PATCH", `/members/${member.id}`, { role: "viewer" })).status).toBe(
      200,
    );
    expect(roleOf(orgA, member)).toBe("viewer");
    expect((await call(admin, "DELETE", `/members/${member.id}`)).status).toBe(204);
    expect(roleOf(orgA, member)).toBe("none");
    expect((await call(owner, "PATCH", `/members/${admin.id}`, { role: "owner" })).status).toBe(
      200,
    );
    // with two owners, one may step down
    expect((await call(owner, "PATCH", `/members/${owner.id}`, { role: "admin" })).status).toBe(
      200,
    );
  });

  it("404 for a person who is not a member, 400 for a bad id, 422 for an unknown role", async () => {
    expect((await call(admin, "DELETE", `/members/${outsider.id}`)).status).toBe(404);
    expect((await call(admin, "DELETE", "/members/not-a-uuid")).status).toBe(400);
    expect((await call(admin, "PATCH", `/members/${viewer.id}`, { role: "boss" })).status).toBe(
      422,
    );
    expect((await call(admin, "PATCH", `/members/${viewer.id}`, {})).status).toBe(422);
  });
});

describe("POST /api/v1/invitations/preview", () => {
  const preview = (actor: Actor | null, token: string) =>
    call(actor, "POST", "/invitations/preview", { token }, null);

  it("200: shows the workspace, the role and whether the signed-in account is the invited one, and never echoes the token or address", async () => {
    const who = await server.member("mb-prev");
    const token = await tokenFor(owner, who.email!, "viewer");
    const res = await preview(who, token);
    expect(res.status).toBe(200);
    const text = await res.text();
    const { data } = JSON.parse(text);
    expect(data).toMatchObject({
      organizationName: "Members Co A",
      role: "viewer",
      emailVerified: true,
      emailMatches: true,
    });
    expect(data.invitedEmailHint).toMatch(/^.\*\*\*@example\.test$/);
    expect(text).not.toContain(token);
    expect(text).not.toContain(who.email!);
    // looking is not joining
    expect(roleOf(orgA, who)).toBe("none");
    const other2 = await preview(outsider, token);
    expect((await other2.json()).data.emailMatches).toBe(false);
  });

  it("refuses with the same stable codes as accepting, and a guest or signed-out caller gets 403 or 401", async () => {
    expect(await code(await preview(outsider, "0".repeat(64)))).toBe("INVITATION_INVALID");
    expect(await code(await preview(outsider, "nope"))).toBe("INVITATION_INVALID");
    const made = await (await invite(owner, `pv-${Date.now()}@example.test`)).json();
    await call(owner, "DELETE", `/invitations/${made.data.id}`);
    expect(await code(await preview(outsider, made.data.token))).toBe("INVITATION_REVOKED");
    const guestRes = await preview(guest, "0".repeat(64));
    expect(guestRes.status).toBe(403);
    expect((await preview(null, "0".repeat(64))).status).toBe(401);
  });
});
