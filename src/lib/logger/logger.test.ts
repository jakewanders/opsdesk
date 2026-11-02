import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "./logger";
import { routeLabel } from "./route-label";

function capture(level?: LogLevel) {
  const lines: Array<{ level: LogLevel; json: Record<string, unknown>; raw: string }> = [];
  const log = createLogger({
    level,
    now: () => new Date("2026-11-02T01:02:03.000Z"),
    sink: (l, raw) => lines.push({ level: l, raw, json: JSON.parse(raw) }),
  });
  return { log, lines };
}

describe("logger", () => {
  it("writes one JSON line with timestamp, level, event and the fields", () => {
    const { log, lines } = capture();
    log.info("api.request", {
      requestId: "r1",
      route: "/api/v1/customers/:id",
      status: 200,
      durationMs: 12,
      orgId: "o",
      userId: "u",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].raw).not.toContain("\n");
    expect(lines[0].json).toEqual({
      requestId: "r1",
      route: "/api/v1/customers/:id",
      status: 200,
      durationMs: 12,
      orgId: "o",
      userId: "u",
      ts: "2026-11-02T01:02:03.000Z",
      level: "info",
      event: "api.request",
    });
  });

  it("redacts secrets, notes and contact data in the line", () => {
    const { log, lines } = capture();
    log.warn("x", {
      requestId: "r",
      notes: "called about the boiler",
      password: "p",
      nested: { Authorization: "Bearer abcdefghijkl" },
      message: "user a@b.co failed",
    });
    expect(lines[0].raw).not.toContain("boiler");
    expect(lines[0].raw).not.toContain("abcdefghijkl");
    expect(lines[0].raw).not.toContain("a@b.co");
    expect(lines[0].json).toMatchObject({
      notes: "[redacted]",
      password: "[redacted]",
      requestId: "r",
    });
  });

  it("a field cannot overwrite level, event or ts", () => {
    const { log, lines } = capture();
    log.error("real.event", { level: "debug", event: "fake", ts: "never" });
    expect(lines[0].json).toMatchObject({
      level: "error",
      event: "real.event",
      ts: "2026-11-02T01:02:03.000Z",
    });
  });

  it("child loggers add their bound fields to every line, and call fields win over bound ones", () => {
    const { log, lines } = capture();
    const child = log.child({ requestId: "r9", route: "/a" });
    child.info("e1");
    child.info("e2", { route: "/b" });
    expect(lines[0].json).toMatchObject({ requestId: "r9", route: "/a" });
    expect(lines[1].json).toMatchObject({ requestId: "r9", route: "/b" });
  });

  it("respects the level: below it nothing is written", () => {
    const { log, lines } = capture("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.json.event)).toEqual(["w", "e"]);
  });

  it("never throws, even for hostile input or a failing sink", () => {
    const hostile = {
      get boom(): string {
        throw new Error("getter");
      },
    };
    const { log } = capture();
    expect(() => log.info("x", hostile)).not.toThrow();
    const failing = createLogger({
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => failing.error("x", { requestId: "r" })).not.toThrow();
  });

  it("logs an Error as name, code and message only", () => {
    const { log, lines } = capture();
    log.error("api.unhandled_error", {
      requestId: "r",
      error: Object.assign(new Error("duplicate key"), {
        code: "23505",
        stack: "at secret/path.ts",
      }),
    });
    expect(lines[0].json.error).toEqual({ name: "Error", code: "23505", message: "duplicate key" });
    expect(lines[0].raw).not.toContain("secret/path");
  });
});

describe("routeLabel", () => {
  it("turns ids into :id and never includes a query string", () => {
    expect(routeLabel("/api/v1/customers/d0d5a9ac-a418-46bf-9e55-483246054f52/restore")).toBe(
      "/api/v1/customers/:id/restore",
    );
    expect(routeLabel("/api/v1/organizations/12345678")).toBe("/api/v1/organizations/:id");
    expect(routeLabel("/api/v1/customers?q=secret+name")).toBe("/api/v1/customers");
    expect(routeLabel("/api/v1/session")).toBe("/api/v1/session");
  });
});

describe("lint: no bare console in server code", () => {
  it("the repository ESLint config rejects console.log in application code and accepts the logger", async () => {
    const { ESLint } = await import("eslint");
    const eslint = new ESLint({ cwd: process.cwd() });
    const lint = async (code: string, filePath: string) =>
      (await eslint.lintText(code, { filePath }))[0].messages.filter(
        (m) => m.ruleId === "no-console",
      );
    expect((await lint(`console.log("x");\n`, "src/lib/zz-probe.ts")).length).toBe(1);
    expect(
      (await lint(`console.error(JSON.stringify(body));\n`, "src/app/api/v1/zz/route.ts")).length,
    ).toBe(1);
    expect(
      await lint(
        `import { logger } from "@/lib/logger/logger";\nlogger.info("x");\n`,
        "src/lib/zz-probe.ts",
      ),
    ).toEqual([]);
    expect(await lint(`console.log("x");\n`, "src/lib/zz-probe.test.ts")).toEqual([]);
  });
});
