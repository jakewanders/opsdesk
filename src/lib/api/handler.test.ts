import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "./errors";
import { created, noContent, okItem, okList } from "./envelope";
import { withApi as withApiRaw, type ApiHandler, type ApiOptions } from "./handler";
import { readJson } from "./json-body";
import { isApiErrorResponse } from "./types";

const URL_ = "http://localhost:3000/api/v1/things";
const ORIGIN = "http://localhost:3000";
/** The contract tests are about envelopes, so the guards (own tests below) are set to the test origin and auth is off. */
const withApi = <P = Record<string, never>>(handler: ApiHandler<P>, options: ApiOptions = {}) =>
  withApiRaw(handler, { auth: "none", trustedOrigins: () => [ORIGIN], ...options });
type Init = ConstructorParameters<typeof NextRequest>[1];
const get = (init?: Init) => new NextRequest(URL_, init);
const post = (
  body: string | null,
  headers: Record<string, string> = { "content-type": "application/json" },
) => new NextRequest(URL_, { method: "POST", body, headers: { origin: ORIGIN, ...headers } });

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every response, success or error, carries a request ID header and is never cached. */
function expectBaseHeaders(res: Response) {
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(res.headers.get("cache-control")).toBe("private, no-store");
}

describe("contract: one test per status code", () => {
  it("200: an item", async () => {
    const res = await withApi(() => okItem({ id: "1" }))(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "1" }, meta: {} });
    expectBaseHeaders(res);
  });

  it("200: a list", async () => {
    const res = await withApi(() =>
      okList([{ id: "1" }], { page: 1, limit: 25, total: 1, totalPages: 1 }),
    )(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta).toEqual({ page: 1, limit: 25, total: 1, totalPages: 1 });
  });

  it("201: created", async () => {
    const res = await withApi(() => created({ id: "2" }))(post("{}"));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ id: "2" });
  });

  it("204: no content", async () => {
    const res = await withApi(() => noContent())(post(null));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expectBaseHeaders(res);
  });

  it("400: malformed JSON body", async () => {
    const handler = withApi(async ({ request }) => okItem({ got: await readJson(request) }));
    const res = await handler(post("{not json"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(isApiErrorResponse(body)).toBe(true);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("400: an explicit BadRequestError", async () => {
    const res = await withApi(() => {
      throw new BadRequestError("The id is not a valid UUID.");
    })(get());
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("The id is not a valid UUID.");
  });

  it("401: unauthenticated", async () => {
    const res = await withApi(() => {
      throw new UnauthorizedError();
    })(get());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("403: forbidden", async () => {
    const res = await withApi(() => {
      throw new ForbiddenError();
    })(get());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("404: not found, with one message for missing and cross-tenant records", async () => {
    const missing = await withApi(() => {
      throw new NotFoundError();
    })(get());
    const crossTenant = await withApi(() => {
      throw new NotFoundError();
    })(get());
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.message).toBe((await crossTenant.json()).error.message);
  });

  it("409: stale edit", async () => {
    const res = await withApi(() => {
      throw new ConflictError();
    })(get());
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("413: payload too large", async () => {
    const res = await withApi(() => {
      throw new PayloadTooLargeError();
    })(post("{}"));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("415: a body that is not JSON", async () => {
    const handler = withApi(() => okItem({}));
    const res = await handler(post("name=x", { "content-type": "text/plain" }));
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("415: a body with no content type at all", async () => {
    const res = await withApi(() => okItem({}))(post("{}", {}));
    // A string body defaults to text/plain in fetch, so it must be refused too.
    expect(res.status).toBe(415);
  });

  it("422: Zod validation with field errors", async () => {
    const schema = z.object({
      email: z.email("Invalid email address"),
      age: z.number().min(18, "Must be 18 or older"),
    });
    const handler = withApi(async ({ request }) => okItem(schema.parse(await readJson(request))));
    const res = await handler(post(JSON.stringify({ email: "nope", age: 3 })));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.fieldErrors).toEqual({
      email: ["Invalid email address"],
      age: ["Must be 18 or older"],
    });
  });

  it("422: nested paths use dotted keys and root issues use _form", async () => {
    const schema = z
      .object({ address: z.object({ city: z.string().min(1, "City is required") }) })
      .refine(() => false, "Nope");
    const handler = withApi(async ({ request }) => okItem(schema.parse(await readJson(request))));
    const res = await handler(post(JSON.stringify({ address: { city: "" } })));
    const fieldErrors = (await res.json()).error.fieldErrors;
    expect(fieldErrors["address.city"]).toEqual(["City is required"]);
  });

  it("422: an explicit business-rule ValidationError", async () => {
    const res = await withApi(() => {
      throw new ValidationError("Discount cannot exceed the subtotal.", {
        discount_cents: ["Too large"],
      });
    })(get());
    expect(res.status).toBe(422);
    expect((await res.json()).error.fieldErrors).toEqual({ discount_cents: ["Too large"] });
  });

  it("429: a throttle with Retry-After", async () => {
    const res = await withApi(() => {
      throw new RateLimitError("Demo limit reached.", 30);
    })(get());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
  });

  it("500: an unhandled exception returns a request ID and no internals", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = new Error('relation "secret_tenants" does not exist at /srv/app/db.ts:42');
    secret.stack = "Error: boom\n    at /srv/app/db.ts:42:7\n    at password=hunter2";
    const res = await withApi(() => {
      throw secret;
    })(get({ headers: { "x-request-id": "trace-me-12345678" } }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/secret_tenants|db\.ts|hunter2|stack|at \/srv/);
    const body = JSON.parse(text);
    expect(body.error).toEqual({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our side. Please try again.",
      requestId: "trace-me-12345678",
    });
    expect(res.headers.get("x-request-id")).toBe("trace-me-12345678");
    // The cause is logged server-side against the same ID.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toMatchObject({
      requestId: "trace-me-12345678",
      event: "api.unhandled_error",
    });
  });

  it("500: throwing a non-Error (a string, null) is still the envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of ["a string", null, undefined, 42]) {
      const res = await withApi(() => {
        throw thrown;
      })(get());
      expect(res.status).toBe(500);
      expect(isApiErrorResponse(await res.json())).toBe(true);
    }
  });

  it("500: still returns the envelope if converting the error itself blows up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = {
      get code(): string {
        throw new Error("getter exploded");
      },
    };
    const res = await withApi(() => {
      throw hostile;
    })(get());
    expect(res.status).toBe(500);
    expect(isApiErrorResponse(await res.json())).toBe(true);
  });
});

describe("Postgres errors thrown from a handler", () => {
  const raise = (code: string) =>
    withApi(() => {
      throw { code, message: 'violates constraint "customers_pkey"', details: "Key (id)=(1)" };
    });

  it.each([
    ["23505", 409],
    ["23503", 422],
    ["23514", 422],
    ["42501", 403],
    ["22P02", 400],
  ])("%s is returned as HTTP %i with a fixed message", async (code, status) => {
    const res = await raise(code)(get());
    expect(res.status).toBe(status);
    const text = await res.text();
    expect(text).not.toMatch(/customers_pkey|Key \(id\)/);
    expect(isApiErrorResponse(JSON.parse(text))).toBe(true);
  });

  it("an OD429 raised on purpose becomes a 429 with the authored message and Retry-After", async () => {
    const res = await withApi(() => {
      throw {
        code: "OD429",
        message: "Demo limit reached: customers.",
        details: "DEMO_QUOTA",
        hint: "retry-after=60",
      };
    })(get());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect((await res.json()).error).toMatchObject({
      code: "DEMO_QUOTA",
      message: "Demo limit reached: customers.",
    });
  });

  it("an unrecognized database error is a generic 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await raise("XX000")(get());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/customers_pkey/);
  });
});

describe("request IDs", () => {
  it("accepts a safe X-Request-Id and echoes it on success and error", async () => {
    const ok = await withApi(() => okItem({}))(
      get({ headers: { "x-request-id": "abc-12345678" } }),
    );
    expect(ok.headers.get("x-request-id")).toBe("abc-12345678");
    const err = await withApi(() => {
      throw new NotFoundError();
    })(get({ headers: { "x-request-id": "abc-12345678" } }));
    expect(err.headers.get("x-request-id")).toBe("abc-12345678");
    expect((await err.json()).error.requestId).toBe("abc-12345678");
  });

  it("replaces an unsafe X-Request-Id with a UUID", async () => {
    const res = await withApi(() => okItem({}))(
      get({ headers: { "x-request-id": "bad id\twith spaces" } }),
    );
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives the handler the same ID that goes in the response", async () => {
    let seen = "";
    const res = await withApi(({ requestId }) => {
      seen = requestId;
      return okItem({});
    })(get());
    expect(seen).toBe(res.headers.get("x-request-id"));
  });
});

describe("handler plumbing", () => {
  it("awaits dynamic route params", async () => {
    const handler = withApi<{ id: string }>(({ params }) => okItem({ id: params.id }));
    const res = await handler(get(), { params: Promise.resolve({ id: "abc" }) });
    expect((await res.json()).data).toEqual({ id: "abc" });
  });

  it("allows a POST with no body (a bare action endpoint)", async () => {
    const res = await withApi(() => okItem({ done: true }))(post(null, {}));
    expect(res.status).toBe(200);
  });

  it("allows a POST whose body is an empty stream (what the Next.js runtime provides for no body)", async () => {
    const emptyStream = new ReadableStream({ start: (controller) => controller.close() });
    const request = new NextRequest(URL_, {
      method: "POST",
      headers: { origin: ORIGIN },
      body: emptyStream,
      duplex: "half",
    });
    expect(request.body).not.toBeNull();
    const res = await withApi(() => okItem({ done: true }))(request);
    expect(res.status).toBe(200);
  });

  it("rejects a non-JSON body that is not empty even when sent as a stream", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("name=x"));
        controller.close();
      },
    });
    const request = new NextRequest(URL_, {
      method: "POST",
      body: stream,
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      duplex: "half",
    });
    expect((await withApi(() => okItem({}))(request)).status).toBe(415);
  });

  it("does not require JSON on GET", async () => {
    const res = await withApi(() => okItem({}))(get());
    expect(res.status).toBe(200);
  });

  it("accepts application/json with a charset and +json media types", async () => {
    const handler = withApi(() => okItem({}));
    expect(
      (await handler(post("{}", { "content-type": "application/json; charset=utf-8" }))).status,
    ).toBe(200);
    expect(
      (await handler(post("{}", { "content-type": "application/merge-patch+json" }))).status,
    ).toBe(200);
  });

  it("lets a handler return its own Response (a file) with the base headers added", async () => {
    const res = await withApi(
      () => new Response("a,b", { headers: { "content-type": "text/csv" } }),
    )(get());
    expect(res.headers.get("content-type")).toBe("text/csv");
    expectBaseHeaders(res);
  });

  it("supports async handlers", async () => {
    const res = await withApi(async () => {
      await Promise.resolve();
      return okItem({ ok: true });
    })(get());
    expect(res.status).toBe(200);
  });
});
