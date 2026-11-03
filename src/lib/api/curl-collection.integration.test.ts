import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer } from "@/test/real-server";

/**
 * [P-19] `scripts/api-collection.sh` is the runnable curl collection: it signs up a guest on the local stack and calls the main endpoints,
 * and exits non-zero when any status differs from the one it expects. Running it against a real production server keeps the examples
 * true: when an endpoint changes, this test fails until the collection (and so the documentation it carries) is updated.
 */
const server = new RealServer();
beforeAll(() => server.start(), 400_000);
afterAll(() => server.stop());

describe("curl collection", () => {
  it("runs to the end against a real server, every call with the status it documents", () => {
    const run = spawnSync("bash", ["scripts/api-collection.sh"], {
      env: { ...process.env, BASE: server.base },
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = `${run.stdout}\n${run.stderr}`;
    expect(run.status, out).toBe(0);
    expect(run.stdout).toContain("collection finished: every call returned the expected status");
    for (const line of [
      "POST /demo/bootstrap -> 200",
      "POST /customers -> 201",
      "-> 409",
      "POST /quotes -> 201",
      "GET /no-such-endpoint -> 404",
    ])
      expect(run.stdout).toContain(line);
    // it shows no secret: the session cookie and tokens are never printed
    expect(run.stdout).not.toMatch(/sb-\w+-auth-token|eyJ[A-Za-z0-9_-]{10,}/);
  });
  it("refuses a Supabase URL that is not the local stack", () => {
    const run = spawnSync("bash", ["scripts/api-collection.sh"], {
      env: {
        ...process.env,
        BASE: server.base,
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "x",
      },
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("not the local stack");
  });
});
