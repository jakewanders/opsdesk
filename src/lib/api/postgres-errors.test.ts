import { describe, expect, it } from "vitest";
import { mapPostgresError } from "./postgres-errors";

// Messages shaped like real Postgres/PostgREST text, full of names that must never reach a client.
const LEAKY = {
  message: 'duplicate key value violates unique constraint "customers_org_email_key"',
  details: "Key (organization_id, email)=(a1b2, secret@example.com) already exists.",
  hint: "internal hint",
};

describe("mapPostgresError: documented mappings", () => {
  it.each([
    ["23505", 409, "DUPLICATE"],
    ["23503", 422, "INVALID_REFERENCE"],
    ["23514", 422, "CHECK_VIOLATION"],
    ["23502", 422, "REQUIRED_VALUE"],
    ["22001", 422, "VALUE_TOO_LONG"],
    ["22003", 422, "VALUE_OUT_OF_RANGE"],
    ["22P02", 400, "BAD_REQUEST"],
    ["42501", 403, "FORBIDDEN"],
    ["PGRST116", 404, "NOT_FOUND"],
    ["PGRST301", 401, "UNAUTHENTICATED"],
  ])("%s becomes HTTP %i %s", (code, status, apiCode) => {
    const mapped = mapPostgresError({ code, ...LEAKY });
    expect(mapped?.status).toBe(status);
    expect(mapped?.code).toBe(apiCode);
  });

  it("never exposes SQL text, constraint names, or values in the message or field errors", () => {
    for (const code of [
      "23505",
      "23503",
      "23514",
      "23502",
      "22001",
      "22003",
      "22P02",
      "42501",
      "PGRST116",
    ]) {
      const mapped = mapPostgresError({ code, ...LEAKY });
      const text = JSON.stringify({ message: mapped?.message, fieldErrors: mapped?.fieldErrors });
      expect(text, code).not.toMatch(
        /customers_org_email_key|secret@example\.com|organization_id|violates|Key \(/,
      );
    }
  });
});

describe("mapPostgresError: custom OD errors raised on purpose", () => {
  it("maps OD403, OD404, OD409, OD422, OD429 to their HTTP statuses and keeps the authored message", () => {
    const table: [string, number][] = [
      ["OD403", 403],
      ["OD404", 404],
      ["OD409", 409],
      ["OD422", 422],
      ["OD429", 429],
    ];
    for (const [code, status] of table) {
      const mapped = mapPostgresError({ code, message: "Written for the user." });
      expect(mapped?.status).toBe(status);
      expect(mapped?.message).toBe("Written for the user.");
    }
  });

  it("takes the machine code from detail only when it is UPPER_SNAKE_CASE", () => {
    expect(mapPostgresError({ code: "OD403", message: "m", details: "DEMO_EXPIRED" })?.code).toBe(
      "DEMO_EXPIRED",
    );
    expect(
      mapPostgresError({ code: "OD403", message: "m", details: "free text with spaces" })?.code,
    ).toBe("FORBIDDEN");
  });

  it("reads Retry-After seconds from the hint on OD429", () => {
    const mapped = mapPostgresError({
      code: "OD429",
      message: "Slow down.",
      details: "RESET_THROTTLED",
      hint: "retry-after=45",
    });
    expect(mapped?.status).toBe(429);
    expect(mapped?.code).toBe("RESET_THROTTLED");
    expect(mapped?.headers).toEqual({ "Retry-After": "45" });
  });

  it("falls back to a safe default message when the raise has none", () => {
    expect(mapPostgresError({ code: "OD404" })?.message).toBe("That record was not found.");
  });
});

describe("mapPostgresError: anything else is not ours", () => {
  it("returns null for P0001 (a generic RAISE) so its text is never shown", () => {
    expect(
      mapPostgresError({ code: "P0001", message: "internal: tenants table corrupted" }),
    ).toBeNull();
  });
  it.each([null, undefined, "boom", 42, {}, { code: 23505 }, new Error("x")])(
    "returns null for %j",
    (value) => {
      expect(mapPostgresError(value)).toBeNull();
    },
  );
});
