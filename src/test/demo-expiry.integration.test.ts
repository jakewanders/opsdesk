import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** Demo expiry over real HTTP: banner while live, redirect and "Your demo has ended" once expired. */
const server = new RealServer();
let live: Actor;
let dead: Actor;
let deadOrg = "";

async function bootstrap(actor: Actor): Promise<string> {
  const token = JSON.parse(Buffer.from(actor.cookie.split("=base64-")[1], "base64url").toString())
    .access_token as string;
  const c = createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return ((await c.rpc("bootstrap_demo_workspace")).data as { organization_id: string })
    .organization_id;
}

beforeAll(async () => {
  await server.start();
  [live, dead] = await Promise.all([server.guest(), server.guest()]);
  await bootstrap(live);
  deadOrg = await bootstrap(dead);
  psql(
    `update public.organizations set expires_at = now() - interval '1 minute' where id = '${deadOrg}'`,
  );
}, 400_000);
afterAll(() => server.stop());

describe("a live demo", () => {
  it("shows the countdown banner with about 24 hours left", async () => {
    const res = await server.request("/app/setup", live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Demo workspace.");
    expect(html).toMatch(/23h 5\d m|24h 00m|23h 59m/);
    expect(html).toContain("Data is fictional");
  });
  it("is not sent to the ended page, and /demo does not say the demo ended", async () => {
    const res = await server.request("/demo", live);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("Your demo has ended");
  });
});

describe("an expired demo", () => {
  it("sends the guest from /app to /demo", async () => {
    const res = await server.request("/app", dead);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!, server.base).pathname).toBe("/demo");
    expect(res.headers.get("cache-control")).toMatch(/private/);
  });
  it("shows 'Your demo has ended' with a Start a new demo button", async () => {
    const res = await server.request("/demo", dead);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Your demo has ended");
    expect(html).toContain("Start a new demo");
    expect(html).not.toContain("Open a private workspace"); // not the entry page
  });
  it("does not show the ended page to a visitor with no session", async () => {
    const html = await (await server.request("/demo", null)).text();
    expect(html).not.toContain("Your demo has ended");
  });
  it("never lets the expired guest keep writing: the database refuses direct SDK writes", async () => {
    const token = JSON.parse(Buffer.from(dead.cookie.split("=base64-")[1], "base64url").toString())
      .access_token as string;
    const c = createClient(server.supabase.apiUrl, server.supabase.publishableKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const rename = await c
      .from("organizations")
      .update({ name: "Renamed after expiry" })
      .eq("id", deadOrg)
      .select();
    expect(rename.data ?? []).toEqual([]);
    expect(psql(`select name from public.organizations where id = '${deadOrg}'`)).toBe(
      "Demo Workspace",
    );
    const extend = await c
      .from("organizations")
      .update({ expires_at: "2099-01-01T00:00:00Z" })
      .eq("id", deadOrg)
      .select();
    expect(extend.error).not.toBeNull();
    expect(
      new Date(
        psql(`select expires_at from public.organizations where id = '${deadOrg}'`),
      ).getTime(),
    ).toBeLessThan(Date.now());
  });
});
