import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-219] The customer list page over real HTTP: first paint comes from the server, scoped by RLS. */
const server = new RealServer();
let guest: Actor;
let member: Actor;

beforeAll(async () => {
  await server.start();
  [guest, member] = await Promise.all([server.guest(), server.member("custpage")]);
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
  expect(
    (await server.request("/api/v1/organizations", member, { json: { name: "Page Co" } })).status,
  ).toBe(201);
}, 400_000);
afterAll(() => server.stop());

/** Page HTML as text: React comment separators between adjacent text nodes removed. */
const page = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");

describe("/app/customers", () => {
  it("a demo guest sees seeded customers in the server-rendered HTML, with pagination text", async () => {
    const res = await server.request("/app/customers", guest);
    expect(res.status).toBe(200);
    const body = (await res.text()).replace(/<!-- -->/g, "");
    expect(body).toContain("Customers");
    expect(body).toContain("<table");
    expect(body).toMatch(/Showing 1 to 15 of 15/); // 18 seeded, 3 archived and hidden by default
    expect(body).toContain("Add customer");
  });

  it("search and filters from the URL are applied on the server", async () => {
    const body = await page("/app/customers?status=lead&limit=10", guest);
    expect(body).toMatch(/Showing 1 to \d+ of \d+/);
    expect(body).not.toMatch(/Showing 1 to \d+ of 15\b/);
    const none = await page("/app/customers?q=zzzznomatchzzzz", guest);
    expect(none).toContain("No customers match");
  });

  it("garbage URL state falls back to defaults instead of failing", async () => {
    const res = await server.request(
      "/app/customers?page=-1&limit=abc&status=%27%3Bdrop&sort=x",
      guest,
    );
    expect(res.status).toBe(200);
  });

  it("a new real workspace shows the empty state, never another tenant's rows", async () => {
    const body = await page("/app/customers", member);
    expect(body).toContain("No customers yet");
    expect(body).not.toContain("<table");
  });
});
