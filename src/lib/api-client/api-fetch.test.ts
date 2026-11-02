import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, buildApiUrl, ClientApiError, isClientApiError } from "./api-fetch";

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
const mockFetch = (res: Response | Error | DOMException) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (!(res instanceof Response)) throw res;
    return res.clone();
  });

afterEach(() => vi.restoreAllMocks());

describe("buildApiUrl", () => {
  it("prefixes /api/v1, keeps an already-prefixed path, and drops empty query values", () => {
    expect(buildApiUrl("/customers")).toBe("/api/v1/customers");
    expect(buildApiUrl("/api/v1/customers")).toBe("/api/v1/customers");
    expect(
      buildApiUrl("/customers", {
        q: "acme",
        page: 2,
        stage: "",
        owner: undefined,
        a: null,
        b: false,
      }),
    ).toBe("/api/v1/customers?q=acme&page=2&b=false");
  });
  it("encodes values", () => {
    expect(buildApiUrl("/customers", { q: "a&b=c d" })).toBe("/api/v1/customers?q=a%26b%3Dc+d");
  });
  it("refuses anything that is not a same-origin path (no absolute URLs, no protocol-relative)", () => {
    for (const bad of ["https://evil.test/x", "//evil.test/x", "customers", "/x://y"]) {
      expect(() => buildApiUrl(bad), bad).toThrow();
    }
  });
});

describe("apiFetch success", () => {
  it("returns { data, meta } and sends same-origin, no-store requests", async () => {
    const spy = mockFetch(
      respond(200, { data: { id: "1" }, meta: { total: 1 } }, { "X-Request-Id": "r1" }),
    );
    const res = await apiFetch<{ id: string }>("/customers/1");
    expect(res).toEqual({ data: { id: "1" }, meta: { total: 1 } });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("/api/v1/customers/1");
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });
  it("sends the JSON body, the workspace and the idempotency key as headers", async () => {
    const spy = mockFetch(respond(201, { data: {}, meta: {} }));
    await apiFetch("/customers", {
      method: "POST",
      json: { name: "Acme" },
      organizationId: "org-1",
      idempotencyKey: "key-12345678",
    });
    const init = spy.mock.calls[0][1]!;
    expect(init.body).toBe(JSON.stringify({ name: "Acme" }));
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Organization-Id": "org-1",
      "Idempotency-Key": "key-12345678",
    });
  });
  it("sends no workspace header when none is selected, and no Content-Type without a body", async () => {
    const spy = mockFetch(respond(200, { data: [], meta: {} }));
    await apiFetch("/customers", { organizationId: null });
    const headers = spy.mock.calls[0][1]!.headers as Record<string, string>;
    expect(headers["X-Organization-Id"]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
  });
  it("treats 204 as an empty success and a missing meta as {}", async () => {
    mockFetch(new Response(null, { status: 204 }));
    expect(await apiFetch("/customers/1", { method: "DELETE" })).toEqual({
      data: undefined,
      meta: {},
    });
    mockFetch(respond(200, { data: [1] }));
    expect((await apiFetch("/x")).meta).toEqual({});
  });
});

describe("apiFetch errors", () => {
  it("maps the error envelope: status, code, message, request id, field errors and meta", async () => {
    mockFetch(
      respond(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Please correct the highlighted fields.",
          fieldErrors: { name: ["Required"] },
          requestId: "req-7",
        },
      }),
    );
    const err = await apiFetch("/customers", { method: "POST", json: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClientApiError);
    expect(isClientApiError(err)).toBe(true);
    expect(err).toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
      requestId: "req-7",
      fieldErrors: { name: ["Required"] },
      isValidation: true,
      isTransient: false,
    });
  });
  it("a stale edit exposes the current version", async () => {
    mockFetch(
      respond(409, {
        error: {
          code: "STALE_EDIT",
          message: "changed",
          requestId: "r",
          meta: { current: { updatedAt: "t" } },
        },
      }),
    );
    const err = (await apiFetch("/c/1", { method: "PATCH", json: {} }).catch(
      (e: unknown) => e,
    )) as ClientApiError;
    expect(err.isStaleEdit).toBe(true);
    expect(err.meta).toEqual({ current: { updatedAt: "t" } });
  });
  it("reads Retry-After on a 429 and falls back to the header's request id", async () => {
    mockFetch(
      respond(
        429,
        { error: { code: "DEMO_QUOTA", message: "full" } },
        { "Retry-After": "60", "X-Request-Id": "hdr" },
      ),
    );
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as ClientApiError;
    expect(err).toMatchObject({
      status: 429,
      code: "DEMO_QUOTA",
      retryAfterSeconds: 60,
      requestId: "hdr",
    });
  });
  it("401 is unauthenticated; 5xx is transient", async () => {
    mockFetch(respond(401, { error: { code: "UNAUTHENTICATED", message: "Sign in" } }));
    expect(
      ((await apiFetch("/x").catch((e: unknown) => e)) as ClientApiError).isUnauthenticated,
    ).toBe(true);
    mockFetch(respond(503, { error: { code: "INTERNAL_ERROR", message: "x" } }));
    expect(((await apiFetch("/x").catch((e: unknown) => e)) as ClientApiError).isTransient).toBe(
      true,
    );
  });
  it("a network failure is NETWORK_ERROR with status 0 and a friendly message", async () => {
    mockFetch(new TypeError("Failed to fetch"));
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as ClientApiError;
    expect(err).toMatchObject({ status: 0, code: "NETWORK_ERROR", isTransient: true });
    expect(err.message).not.toContain("Failed to fetch");
  });
  it("an abort is re-thrown as is, not turned into an API error", async () => {
    mockFetch(new DOMException("aborted", "AbortError"));
    const err = await apiFetch("/x").catch((e: unknown) => e);
    expect((err as Error).name).toBe("AbortError");
    expect(isClientApiError(err)).toBe(false);
  });
  it("a non-JSON or malformed body is INVALID_RESPONSE, never a crash", async () => {
    mockFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    expect(await apiFetch("/x").catch((e: unknown) => e)).toMatchObject({
      status: 502,
      code: "INVALID_RESPONSE",
    });
    mockFetch(new Response("<html>", { status: 200 }));
    expect(await apiFetch("/x").catch((e: unknown) => e)).toMatchObject({
      status: 0,
      code: "INVALID_RESPONSE",
    });
    mockFetch(respond(200, { nope: true }));
    expect(await apiFetch("/x").catch((e: unknown) => e)).toMatchObject({
      code: "INVALID_RESPONSE",
    });
    mockFetch(respond(400, { something: "else" }));
    expect(await apiFetch("/x").catch((e: unknown) => e)).toMatchObject({
      status: 400,
      code: "INVALID_RESPONSE",
    });
  });
  it("never puts a server stack or SQL text into the message (only the envelope's own message)", async () => {
    mockFetch(
      respond(500, {
        error: {
          code: "INTERNAL_ERROR",
          message: "Something went wrong on our side. Please try again.",
          requestId: "r",
        },
      }),
    );
    const err = (await apiFetch("/x").catch((e: unknown) => e)) as ClientApiError;
    expect(err.message).toBe("Something went wrong on our side. Please try again.");
  });
});
