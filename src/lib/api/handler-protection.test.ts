import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { okItem } from "./envelope";
import { withApi } from "./handler";
import { readJson } from "./json-body";

const APP = "https://opsdesk.sitelaunch.dev";
const URL_ = `${APP}/api/v1/things`;
const user = { id: "u1", email: "a@example.com", isAnonymous: false };
const options = { trustedOrigins: () => [APP], resolveUser: async () => user };
const post = (headers: Record<string, string>, body = "{}") =>
  new NextRequest(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });

describe("withApi request protection", () => {
  it("rejects a cross-origin POST even with a valid session cookie", async () => {
    const handler = vi.fn(() => okItem({}));
    const res = await withApi(
      handler,
      options,
    )(post({ origin: "https://evil.example", cookie: "sb-access-token=valid" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_FORBIDDEN");
    expect(body.error.requestId).toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a missing Origin and a spoofed forwarded host", async () => {
    const handler = vi.fn(() => okItem({}));
    const api = withApi(handler, options);
    expect((await api(post({}))).status).toBe(403);
    expect(
      (
        await api(
          post({ "x-forwarded-host": "opsdesk.sitelaunch.dev", host: "opsdesk.sitelaunch.dev" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          post({ origin: "https://evil.example", "x-forwarded-host": "opsdesk.sitelaunch.dev" }),
        )
      ).status,
    ).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts a same-origin POST and passes the verified user to the handler", async () => {
    const res = await withApi(
      ({ user: u }) => okItem({ id: u?.id }),
      options,
    )(post({ origin: APP }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: "u1" });
  });

  it("does not run the Origin check on GET", async () => {
    const res = await withApi(
      () => okItem({}),
      options,
    )(new NextRequest(URL_, { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(200);
  });

  it("returns 401 when the session is not valid, after the origin check passes", async () => {
    const res = await withApi(() => okItem({}), { ...options, resolveUser: async () => null })(
      post({ origin: APP }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  it("answers a cross-origin caller with 403, not 401, so signed-out state is not probed", async () => {
    const res = await withApi(() => okItem({}), { ...options, resolveUser: async () => null })(
      post({ origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it('auth "optional" lets a signed-out caller through with user = null', async () => {
    const res = await withApi(({ user: u }) => okItem({ anon: u === null }), {
      ...options,
      auth: "optional",
      resolveUser: async () => null,
    })(post({ origin: APP }));
    expect((await res.json()).data).toEqual({ anon: true });
  });

  it('auth "none" never calls the resolver', async () => {
    const resolveUser = vi.fn(async () => null);
    await withApi(() => okItem({}), { ...options, auth: "none", resolveUser })(
      post({ origin: APP }),
    );
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it("the Origin check can be skipped only by explicit opt-out (signed webhooks)", async () => {
    const res = await withApi(() => okItem({}), {
      ...options,
      auth: "none",
      skipOriginCheck: true,
    })(post({}));
    expect(res.status).toBe(200);
  });

  it("rejects an oversized declared body with 413 before the handler or the parser runs", async () => {
    const handler = vi.fn(() => okItem({}));
    const big = JSON.stringify({ pad: "x".repeat(101 * 1024) });
    const res = await withApi(
      handler,
      options,
    )(post({ origin: APP, "content-length": String(big.length) }, big));
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("caps the body even when Content-Length lies or is absent (readJson streams with a limit)", async () => {
    const big = JSON.stringify({ pad: "x".repeat(101 * 1024) });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const request = new NextRequest(URL_, {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json", origin: APP },
      duplex: "half",
    });
    const res = await withApi(
      async ({ request: r }) => okItem({ body: await readJson(r) }),
      options,
    )(request);
    expect(res.status).toBe(413);
  });

  it("allows a larger body on a route that raises the cap", async () => {
    const big = JSON.stringify({ pad: "x".repeat(150 * 1024) });
    const res = await withApi(
      async ({ request }) => okItem({ n: Object.keys((await readJson(request)) as object).length }),
      {
        ...options,
        maxBodyBytes: 2 * 1024 * 1024,
      },
    )(post({ origin: APP }, big));
    expect(res.status).toBe(200);
  });

  it("keeps the 100 KB default for a body just under the cap", async () => {
    const body = JSON.stringify({ pad: "x".repeat(100 * 1024 - 20) });
    const res = await withApi(
      async ({ request }) => okItem({ ok: !!(await readJson(request)) }),
      options,
    )(post({ origin: APP }, body));
    expect(res.status).toBe(200);
  });

  it("still rejects non-JSON bodies with 415 after the origin check", async () => {
    const res = await withApi(
      () => okItem({}),
      options,
    )(post({ origin: APP, "content-type": "text/plain" }, "hello"));
    expect(res.status).toBe(415);
  });
});
