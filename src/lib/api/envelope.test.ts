import { describe, expect, it } from "vitest";
import { ConflictError, RateLimitError, ValidationError } from "./errors";
import {
  created,
  errorResponse,
  isApiResult,
  noContent,
  okItem,
  okList,
  successResponse,
  withBaseHeaders,
} from "./envelope";
import { isApiErrorResponse } from "./types";

describe("success helpers", () => {
  it("okItem returns an object in data and an empty meta by default", () => {
    const res = okItem({ id: "1", name: "Acme" });
    expect(res).toMatchObject({ status: 200, body: { data: { id: "1", name: "Acme" }, meta: {} } });
    expect(isApiResult(res)).toBe(true);
  });

  it("okItem rejects an array, so an item endpoint can never switch to a list", () => {
    expect(() => okItem([] as unknown as object)).toThrow(TypeError);
  });

  it("okList always returns an array in data, even when empty, with pagination meta", () => {
    const res = okList([], { page: 1, limit: 25, total: 0, totalPages: 0 });
    expect(res.body).toEqual({ data: [], meta: { page: 1, limit: 25, total: 0, totalPages: 0 } });
  });

  it("okList rejects an object", () => {
    expect(() => okList({} as unknown as unknown[])).toThrow(TypeError);
  });

  it("created is a 201 with the record", () => {
    expect(created({ id: "9" })).toMatchObject({ status: 201, body: { data: { id: "9" } } });
  });

  it("noContent is a 204 with no body", () => {
    expect(noContent()).toEqual({ __apiResult: true, status: 204, body: undefined });
  });
});

describe("successResponse", () => {
  it("serializes data and meta with JSON, request ID, and no-store headers", async () => {
    const res = successResponse(okList([{ id: "1" }], { total: 1 }), "req-12345678");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ data: [{ id: "1" }], meta: { total: 1 } });
  });

  it("sends 204 with no body and no content type", async () => {
    const res = successResponse(noContent(), "req-12345678");
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("x-request-id")).toBe("req-12345678");
  });
});

describe("errorResponse", () => {
  it("uses the documented envelope with the request ID in header and body", async () => {
    const res = errorResponse(new ConflictError(), "req-abcdefgh");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "CONFLICT",
        message: "This record was changed by someone else. Reload and try again.",
        requestId: "req-abcdefgh",
      },
    });
    expect(isApiErrorResponse(body)).toBe(true);
    expect(res.headers.get("x-request-id")).toBe("req-abcdefgh");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("includes fieldErrors only when there are some", async () => {
    const withFields = await errorResponse(
      new ValidationError("Please correct the highlighted fields.", {
        email: ["Invalid email address"],
      }),
      "req-abcdefgh",
    ).json();
    expect(withFields.error.fieldErrors).toEqual({ email: ["Invalid email address"] });
    const without = await errorResponse(new ValidationError(), "req-abcdefgh").json();
    expect(without.error).not.toHaveProperty("fieldErrors");
  });

  it("adds Retry-After for a throttle", () => {
    const res = errorResponse(new RateLimitError(undefined, 59.2), "req-abcdefgh");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("withBaseHeaders", () => {
  it("adds the request ID and no-store to a handler's own Response, keeping its status and headers", () => {
    const res = withBaseHeaders(
      new Response("a,b\n1,2", { status: 200, headers: { "Content-Type": "text/csv" } }),
      "req-abcdefgh",
    );
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("x-request-id")).toBe("req-abcdefgh");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps a Cache-Control the handler set deliberately", () => {
    const res = withBaseHeaders(
      new Response("x", { headers: { "Cache-Control": "private, max-age=60" } }),
      "req-abcdefgh",
    );
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
  });
});

describe("isApiErrorResponse", () => {
  it("rejects bodies that are not the envelope", () => {
    expect(isApiErrorResponse(null)).toBe(false);
    expect(isApiErrorResponse({ data: [] })).toBe(false);
    expect(isApiErrorResponse({ error: "oops" })).toBe(false);
    expect(isApiErrorResponse({ error: { code: "X", message: "m" } })).toBe(false);
  });
});
