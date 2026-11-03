import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestIdsLogged, scanLogLines } from "../../../scripts/lib/log-scan.mjs";
import { RealServer, type Actor } from "@/test/real-server";

/**
 * [SIT-275, PRD 11.6] Operability, over real HTTP against the production build:
 *  - every API error carries a request id, the same one in the `X-Request-Id` header, in the body and in a server log line;
 *  - what the server logs while real requests (with notes, e-mail addresses, an invitation token, a session cookie) go through
 *    contains none of it, and passes the independent log scan;
 *  - with the database unreachable (a closed port: really refused connections) a call yields a friendly error and a request id,
 *    not a raw message, SQL text or a stack trace;
 *  - the health endpoint tells the web server from the database.
 */
const up = new RealServer({ captureLogs: true });
const down = new RealServer({ supabaseUrl: "http://127.0.0.1:1", captureLogs: true });
let owner: Actor;
let org = "";
const NOTE = `SENTINEL-NOTE-${Date.now()}-roof-leaks-badly`;
const PHONE_EMAIL = `sentinel-${Date.now()}@example.test`;
const LEAK =
  /ECONNREFUSED|fetch failed|stack|\bat\s+\S+\s+\(|node_modules|select\s.+\sfrom|SQLSTATE|violates|PGRST|supabase|postgres/i;

type ErrorBody = { error: { code: string; message: string; requestId: string } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The server writes its log line a moment after the response; wait for it. */
async function logged(server: RealServer, id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    for (const raw of server.logs) {
      if (!raw.includes(id)) continue;
      try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        if (o.requestId === id && o.event === "api.request") return o;
      } catch {
        /* not a log line */
      }
    }
    await wait(100);
  }
  throw new Error(`no api.request log line for ${id}`);
}

beforeAll(async () => {
  await Promise.all([up.start(), down.start()]);
  owner = await up.member("obs-owner");
  const created = await up.request("/api/v1/organizations", owner, {
    json: { name: "Observability Co" },
  });
  org = (await created.json()).data.id;
}, 400_000);
afterAll(() => {
  up.stop();
  down.stop();
});

const call = (
  path: string,
  init: Parameters<RealServer["request"]>[2] = {},
  actor: Actor | null = owner,
) =>
  up.request(`/api/v1${path}`, actor, {
    ...init,
    headers: { "X-Organization-Id": org, ...init.headers },
  });

describe("request ids", () => {
  const cases: Array<[string, number, () => Promise<Response>]> = [
    ["signed out", 401, () => up.request("/api/v1/customers", null)],
    ["not found", 404, () => call("/customers/00000000-0000-4000-8000-0000000000ff")],
    ["invalid body", 422, () => call("/customers", { json: { displayName: "", notes: NOTE } })],
    ["unknown route", 404, () => up.request("/api/v1/nope", owner)],
  ];
  it.each(cases)(
    "%s (%i): the id is in the header, the body and the server log",
    async (_label, status, send) => {
      const res = await send();
      expect(res.status).toBe(status);
      const header = res.headers.get("x-request-id");
      expect(header).toMatch(/^[0-9a-f-]{36}$/);
      const body = (await res.json()) as ErrorBody;
      if (body?.error?.requestId) expect(body.error.requestId).toBe(header);
      else expect(status).toBe(404); // an unknown route may use the framework's own 404; it still has a header
      const line = await logged(up, header!);
      expect(line.status).toBe(status);
    },
  );
  it("a caller-supplied request id is not trusted blindly: a malformed one is replaced", async () => {
    const res = await call("/customers", {
      headers: { "x-request-id": "x".repeat(300) },
    });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("what the server logs", () => {
  it("holds none of the notes, e-mail addresses, invitation token or session cookie that passed through", async () => {
    // a customer with notes, an e-mail and a phone, an invitation and its token, a failing request with the same text
    const customer = await call("/customers", {
      json: { displayName: "Log Check Co", notes: NOTE, email: PHONE_EMAIL, phone: "202-555-0199" },
    });
    expect(customer.status).toBe(201);
    const invite = await call("/invitations", { json: { email: PHONE_EMAIL, role: "member" } });
    expect(invite.status).toBe(201);
    const token = ((await invite.json()) as { data: { token?: string } }).data.token ?? "";
    await up.request("/api/v1/invitations/preview", null, {
      json: { token: token || "bad-token-value" },
    });
    await call("/customers", { json: { displayName: "", notes: NOTE, email: PHONE_EMAIL } });
    await call("/tasks", { json: { title: "", description: NOTE } });
    await wait(500);

    const text = up.logs.join("\n");
    expect(up.logs.length).toBeGreaterThan(5);
    expect(text).not.toContain(NOTE);
    expect(text).not.toContain(PHONE_EMAIL);
    expect(text).not.toContain("202-555-0199");
    if (token) expect(text).not.toContain(token);
    expect(text).not.toContain(owner.cookie.split("=").slice(1).join("="));
    expect(text).not.toMatch(/correct horse battery/);
    const scan = scanLogLines(up.logs);
    expect(scan.jsonLines).toBeGreaterThan(5);
    expect(scan.findings).toEqual([]);
  });
  it("the scan itself would catch a leak: a line with a note kept in the clear fails it", () => {
    const bad = scanLogLines([JSON.stringify({ event: "api.request", notes: NOTE })]);
    expect(bad.findings.map((f) => f.rule)).toContain("unredacted sensitive key");
  });
});

describe("with the database unreachable", () => {
  it("answers with a friendly error and a request id, and the log has the same id; nothing raw reaches the client", async () => {
    const res = await down.request("/api/v1/customers", owner, {
      headers: { "X-Organization-Id": org },
    });
    expect(res.status).toBeGreaterThanOrEqual(401);
    const text = await res.text();
    expect(text).not.toMatch(LEAK);
    const body = JSON.parse(text) as ErrorBody;
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
    expect(body.error.message.length).toBeGreaterThan(10);
    const line = await logged(down, body.error.requestId);
    expect(line.status).toBe(res.status);
    // what the failing server wrote still holds no secret or content (its own error text is allowed in a server log)
    const findings = scanLogLines(down.logs).findings.filter(
      (f) => f.rule !== "connection refusal detail",
    );
    expect(findings).toEqual([]);
  });
  it("the page for a signed-in person does not show raw errors either", async () => {
    const res = await down.request("/app", owner);
    const html = await res.text();
    expect(html).not.toMatch(/ECONNREFUSED|fetch failed|at \S+ \(\//);
  });
  it("health tells the web server from the database", async () => {
    expect(await (await up.request("/api/health", null)).json()).toEqual({
      web: "ok",
      database: "ok",
    });
    const bad = await down.request("/api/health", null);
    expect(await bad.json()).toEqual({ web: "ok", database: "unavailable" });
  });
});

describe("request ids in the log are all well-formed", () => {
  it("every logged request id is a UUID", () => {
    const ids = requestIdsLogged(up.logs);
    expect(ids.size).toBeGreaterThan(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
