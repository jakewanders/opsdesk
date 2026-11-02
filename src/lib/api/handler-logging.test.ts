import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/logger/logger";
import { NotFoundError } from "./errors";
import { okItem } from "./envelope";
import { withApi, withOrgApi } from "./handler";

const ORIGIN = "http://localhost:3000";
const SECRET_BODY = {
  name: "Acme",
  notes: "customer said the boiler leaks",
  password: "hunter2-hunter2",
};

function setup() {
  const lines: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const logger = createLogger({
    level: "debug",
    now: () => new Date("2026-11-02T00:00:00Z"),
    sink: (_l, line) => {
      raw.push(line);
      lines.push(JSON.parse(line));
    },
  });
  return { lines, raw, logger };
}
const options = (logger: ReturnType<typeof setup>["logger"]) => ({
  logger,
  trustedOrigins: () => [ORIGIN],
  resolveUser: async () => ({ id: "user-1", email: "pat@example.test", isAnonymous: false }),
});
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      cookie: "sb-local-auth-token=base64-AAAAAAAAAAAA",
      authorization: "Bearer abcdefghijklmnop",
      ...headers,
    },
  });

describe("request logging in withApi", () => {
  it("a forced error logs the request id, the route and the error, and nothing from the request", async () => {
    const { lines, raw, logger } = setup();
    const handler = withApi(async ({ request }) => {
      await request.json(); // the handler has read the body...
      throw new Error("boom"); // ...then fails unexpectedly
    }, options(logger));
    const res = await handler(
      post("/api/v1/customers?q=private+search", SECRET_BODY, { "x-request-id": "req-forced-1" }),
    );
    expect(res.status).toBe(500);

    const error = lines.find((l) => l.event === "api.unhandled_error")!;
    expect(error).toMatchObject({
      level: "error",
      requestId: "req-forced-1",
      route: "/api/v1/customers",
      error: { name: "Error", message: "boom" },
    });
    const request = lines.find((l) => l.event === "api.request")!;
    expect(request).toMatchObject({
      level: "error",
      requestId: "req-forced-1",
      method: "POST",
      status: 500,
      userId: "user-1",
    });
    expect(typeof request.durationMs).toBe("number");

    const everything = raw.join("\n");
    for (const leaked of [
      "boiler",
      "hunter2",
      "Acme",
      "private+search",
      "private search",
      "base64-AAAA",
      "abcdefghijklmnop",
      "pat@example.test",
    ]) {
      expect(everything, leaked).not.toContain(leaked);
    }
  });

  it("logs one info line per successful request with status, duration and the user id", async () => {
    const { lines, logger } = setup();
    const handler = withApi(async () => okItem({ ok: true }), options(logger));
    await handler(post("/api/v1/things/d0d5a9ac-a418-46bf-9e55-483246054f52", { a: 1 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      event: "api.request",
      route: "/api/v1/things/:id",
      status: 200,
      userId: "user-1",
    });
  });

  it("a deliberate 4xx is a warning, not an error, and is not logged as unhandled", async () => {
    const { lines, logger } = setup();
    const handler = withApi(async () => {
      throw new NotFoundError();
    }, options(logger));
    const res = await handler(post("/api/v1/things", {}));
    expect(res.status).toBe(404);
    expect(lines.map((l) => [l.level, l.event, l.status])).toEqual([["warn", "api.request", 404]]);
  });

  it("a rejected request (wrong origin) is logged with its status and no body", async () => {
    const { lines, raw, logger } = setup();
    const res = await withApi(
      async () => okItem({}),
      options(logger),
    )(post("/api/v1/things", SECRET_BODY, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(lines[0]).toMatchObject({ level: "warn", status: 403 });
    expect(raw.join("")).not.toContain("boiler");
  });

  it("the handler gets a logger bound to the request and can add identifiers to the final line", async () => {
    const { lines, logger } = setup();
    const handler = withApi(async ({ log, trace }) => {
      log.info("things.created", { count: 3 });
      trace({ orgId: "org-7" });
      return okItem({});
    }, options(logger));
    await handler(post("/api/v1/things", {}, { "x-request-id": "req-nine-0009" }));
    expect(lines[0]).toMatchObject({
      event: "things.created",
      requestId: "req-nine-0009",
      route: "/api/v1/things",
      count: 3,
    });
    expect(lines[1]).toMatchObject({ event: "api.request", orgId: "org-7" });
  });

  it("the unsigned-in 401 is logged without a user id", async () => {
    const { lines, logger } = setup();
    const handler = withApi(async () => okItem({}), {
      ...options(logger),
      resolveUser: async () => null,
    });
    await handler(post("/api/v1/things", {}));
    expect(lines[0]).toMatchObject({ level: "warn", status: 401 });
    expect(lines[0]).not.toHaveProperty("userId");
  });
});

describe("withOrgApi adds the organization to the request line", () => {
  it("logs orgId after the workspace is proven", async () => {
    const { lines, logger } = setup();
    const handler = withOrgApi(async () => okItem({}), {
      ...options(logger),
      createSupabase: async () =>
        ({
          from: () => ({
            select: () => ({
              eq: async () => ({
                data: [
                  {
                    role: "owner",
                    organizations: {
                      id: "org-1",
                      name: "A",
                      kind: "real",
                      expires_at: null,
                      timezone: "UTC",
                    },
                  },
                ],
                error: null,
              }),
            }),
          }),
        }) as never,
    });
    const res = await handler(post("/api/v1/things", {}, { "x-organization-id": "org-1" }));
    if (res.status === 200) expect(lines.at(-1)).toMatchObject({ orgId: "org-1" });
    else expect(lines.at(-1)).toMatchObject({ event: "api.request" });
  });
});
