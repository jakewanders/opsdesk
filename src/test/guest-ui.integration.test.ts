import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-211] The guest banner, the settings restrictions and the fictional-data labels over real HTTP. */
const server = new RealServer();
let guest: Actor;
let member: Actor;

beforeAll(async () => {
  await server.start();
  [guest, member] = await Promise.all([server.guest(), server.member("guestui")]);
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
  expect(
    (await server.request("/api/v1/organizations", member, { json: { name: "Real Co" } })).status,
  ).toBe(201);
}, 400_000);
afterAll(() => server.stop());

const BANNER = "Demo workspace • fictional data • resets automatically";
const pages = [
  "/app",
  "/app/customers",
  "/app/opportunities",
  "/app/tasks",
  "/app/reports",
  "/app/activity",
  "/app/settings/organization",
  "/app/settings/members",
];

const html = async (path: string, actor: Actor) => {
  const res = await server.request(path, actor);
  expect(res.status, path).toBe(200);
  return res.text();
};

describe("guest mode", () => {
  it("the banner is on every /app page, with Reset Demo and Create an account", async () => {
    for (const path of pages) {
      const body = await html(path, guest);
      expect(body, path).toContain(BANNER);
      expect(body, path).toContain("Reset Demo");
      expect(body, path).toContain("Create an account");
      expect(body, path).toContain("demo data is not carried over");
    }
  });

  it("every page carries the fictional-data footer note", async () => {
    for (const path of pages)
      expect(await html(path, guest), path).toContain("fictional demonstration data");
  });

  it("settings show the read-only notice with every restricted feature and its reason", async () => {
    for (const path of ["/app/settings/organization", "/app/settings/members"]) {
      const body = await html(path, guest);
      expect(body, path).toContain("Settings are read-only in the demo");
      for (const feature of [
        "Invite members",
        "Billing",
        "Integrations",
        "Send external email",
        "Upload files",
        "Create a real workspace",
      ]) {
        expect(body, `${path} ${feature}`).toContain(feature);
      }
    }
  });
});

describe("real users", () => {
  it("never see the banner, the guest notice or the fictional-data label", async () => {
    for (const path of pages) {
      const body = await html(path, member);
      expect(body, path).not.toContain("resets automatically");
      expect(body, path).not.toContain("Reset Demo");
      expect(body, path).not.toContain("Settings are read-only in the demo");
      expect(body, path).not.toContain("fictional demonstration data");
    }
  });
});
