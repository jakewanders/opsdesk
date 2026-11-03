import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { psql } from "../src/test/local-supabase";
import {
  addMember,
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  PASSWORD,
  signIn,
  trackBrowserUser,
  type Person,
} from "./support/local";

/**
 * [P-07, PRD 11.4] E2E scenarios 1 to 6, consolidated and runnable together with `npm run test:e2e:scenarios`. Scenarios 1, 2 and 3 were
 * written with the features they test (`guest-customers`, `dashboard-propagation`, `dashboard`); the map test below keeps them honest
 * (it fails if one of those specs loses the named test). Scenarios 4, 5 and 6 are written here, whole, in a real browser:
 *   4  two guests in separate browser contexts cannot see or reach each other's data
 *   5  sign up with the real form, confirm the e-mail, create a workspace, add data, sign out, sign back in, the data is there
 *   6  a viewer sees the lists, every write control is absent or disabled in the UI, and the same writes are refused by the API
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(() => {
  // the account created in scenario 5 owns a workspace with history: remove the workspace (and its history) first
  psql(
    `delete from public.organizations where created_by in (select id from auth.users where email like 'scenario5-%@example.test')`,
  );
  psql(`delete from auth.users where email like 'scenario5-%@example.test'`);
  cleanUp();
});

const INBUCKET = "http://127.0.0.1:54324";
async function confirmationCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = (await (
      await fetch(`${INBUCKET}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages?: Array<{ ID: string }> };
    const id = found.messages?.[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${INBUCKET}/api/v1/message/${id}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const link = /https?:\/\/[^\s"'<>)]*\/auth\/v1\/verify\?[^\s"'<>)]*/.exec(
        `${msg.Text ?? ""} ${msg.HTML ?? ""}`,
      )?.[0];
      if (link) {
        const res = await fetch(link.replace(/&amp;/g, "&"), { redirect: "manual" });
        const code = new URL(res.headers.get("location") ?? "", "http://x").searchParams.get(
          "code",
        );
        if (code) return code;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no confirmation code arrived for ${email}`);
}

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}
const apiJson = async (page: Page, path: string) =>
  (await page.request.get(`/api/v1${path}`)).json();

test("scenario map: 1, 2 and 3 are covered by their own specs, named here so they cannot disappear", () => {
  const needs: Array<[string, string, string]> = [
    [
      "1",
      "e2e/guest-customers.spec.ts",
      "a guest creates, edits, archives and restores a customer and sees every event",
    ],
    [
      "2",
      "e2e/dashboard-propagation.spec.ts",
      "moving a deal and closing it changes pipeline and weighted pipeline by the exact computed amounts",
    ],
    [
      "3",
      "e2e/dashboard.spec.ts",
      "a stage move and a completed task change them, and a reload agrees",
    ],
  ];
  for (const [n, file, title] of needs)
    expect(readFileSync(file, "utf8"), `scenario ${n}: ${file}`).toContain(title);
});

test("scenario 4: guest A and guest B, in separate browser contexts, cannot see or reach each other's data", async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const pa = await a.newPage();
    const pb = await b.newPage();
    await enterDemo(pa);
    await enterDemo(pb);

    // A creates a customer through the UI
    const secret = `Only A Sees This ${Date.now()}`;
    await pa.goto("/app/customers/new");
    await pa.getByLabel("Display name").fill(secret);
    await pa.getByRole("button", { name: "Add customer" }).click();
    await expect(pa.getByRole("heading", { name: new RegExp(secret) })).toBeVisible();
    const aId = pa.url().split("/").pop()!;

    // B does not see it: not in the list, not in a search, not in the activity feed, and A's id is a plain 404 for B
    await pb.goto("/app/customers");
    await expect(pb.getByRole("table")).toBeVisible();
    await expect(pb.getByText(secret)).toHaveCount(0);
    await pb.goto(`/app/customers?q=${encodeURIComponent("Only A Sees")}`);
    await expect(pb.getByText(secret)).toHaveCount(0);
    await pb.goto("/app/activity");
    await expect(pb.getByText(secret)).toHaveCount(0);
    expect((await pb.request.get(`/api/v1/customers/${aId}`)).status()).toBe(404);
    const direct = await pb.goto(`/app/customers/${aId}`);
    await expect(pb.getByRole("heading", { name: "Not found" })).toBeVisible();
    expect(
      direct?.status() === 404 ||
        (await pb.getByRole("heading", { name: "Not found" }).count()) === 1,
    ).toBe(true);

    // B cannot change it either, and cannot target A's workspace by naming it
    const aOrg =
      (await apiJson(pa, "/session")).data.activeOrganizationId ??
      (await apiJson(pa, "/organizations")).data[0].id;
    const forged = await pb.request.patch(`/api/v1/customers/${aId}`, {
      data: { notes: "defaced", expectedUpdatedAt: "2020-01-01T00:00:00.000000+00:00" },
      headers: { "X-Organization-Id": aOrg, origin: "http://localhost:3111" },
    });
    expect([403, 404]).toContain(forged.status());
    expect((await apiJson(pa, `/customers/${aId}`)).data.notes).toBeNull();

    // and the other direction
    await pb.goto("/app/customers/new");
    await pb.getByLabel("Display name").fill(`Only B Sees This ${Date.now()}`);
    await pb.getByRole("button", { name: "Add customer" }).click();
    await pa.goto("/app/customers");
    await expect(pa.getByText("Only B Sees This")).toHaveCount(0);
  } finally {
    await trackBrowserUser(a);
    await trackBrowserUser(b);
    await a.close();
    await b.close();
  }
});

test("scenario 5: sign up, confirm, create a workspace, add data, sign out, sign in: the data survives", async ({
  page,
}) => {
  const email = `scenario5-${Date.now()}@example.test`;
  await page.goto("/signup");
  await expect(page.locator('input[name="captchaToken"]')).not.toHaveValue("", { timeout: 20_000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Create account|Sign up/ }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible({
    timeout: 30_000,
  });

  // the confirmation e-mail (read from the local mail catcher) signs the person in through the app's own callback
  const code = await confirmationCode(email);
  await page.goto(`/auth/callback?next=/app&code=${code}`);
  await page.waitForURL(/\/app/, { timeout: 30_000 });

  // a new account has no workspace yet: create one
  await page.goto("/app/setup");
  await page.getByLabel("Workspace name").fill("Scenario 5 Plumbing");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/app(\?.*)?$/, { timeout: 30_000 });

  // add a record
  const name = `Survives Logout ${Date.now()}`;
  await page.goto("/app/customers/new");
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();

  // sign out: the app is closed to this browser
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/app"), { timeout: 30_000 });
  await page.goto("/app/customers");
  await expect(page).toHaveURL(/\/login/);

  // sign back in with the same credentials: the workspace and the customer are there
  await expect(page.locator('input[name="captchaToken"]')).not.toHaveValue("", { timeout: 20_000 });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
  await page.goto("/app/customers");
  await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
  expect(
    psql(
      `select count(*) from public.customers c join public.organizations o on o.id = c.organization_id where o.name = 'Scenario 5 Plumbing' and c.display_name = '${name}'`,
    ),
  ).toBe("1");
});

test.describe("scenario 6: a viewer reads everything and writes nothing", () => {
  let owner: Person, viewer: Person;
  let org = "";
  let customerId = "";
  test.beforeAll(async () => {
    [owner, viewer] = await Promise.all([makeUser("s6o"), makeUser("s6v")]);
    org = await makeWorkspace(owner, "E2E Scenario 6 Co");
    addMember(org, viewer, "viewer");
    customerId = (
      (await (
        await api(owner, "POST", "/customers", org, { displayName: "Scenario Six Customer" })
      ).json()) as { data: { id: string } }
    ).data.id;
    await api(owner, "POST", "/tasks", org, { title: "Scenario Six Task" });
  });

  test("lists are visible; there is no add, edit or archive control; the API refuses every write", async ({
    page,
    context,
  }) => {
    await signIn(context, viewer);
    // reads
    await page.goto("/app/customers");
    await expect(page.getByRole("link", { name: "Scenario Six Customer" })).toBeVisible();
    await page.goto("/app/tasks");
    await expect(page.getByText("Scenario Six Task").first()).toBeVisible();
    // no write controls in the UI
    await page.goto("/app/customers");
    await expect(page.getByRole("link", { name: /Add customer/ })).toHaveCount(0);
    await page.goto(`/app/customers/${customerId}`);
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
    await page.goto("/app/tasks");
    await expect(page.getByRole("button", { name: "Add task" })).toHaveCount(0);
    // and the same writes, attempted directly, are refused with the permission error
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/customers", { displayName: "Viewer Made" }],
      [
        "PATCH",
        `/customers/${customerId}`,
        { notes: "x", expectedUpdatedAt: "2020-01-01T00:00:00.000000+00:00" },
      ],
      ["DELETE", `/customers/${customerId}`, undefined],
      ["POST", "/tasks", { title: "Viewer Task" }],
      ["POST", "/invitations", { email: "x@example.test", role: "member" }],
    ];
    for (const [method, path, json] of writes) {
      const res = await api(viewer, method, path, org, json);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }
    // nothing changed
    expect(psql(`select count(*) from public.customers where organization_id = '${org}'`)).toBe(
      "1",
    );
    expect(
      psql(`select archived_at is null from public.customers where id = '${customerId}'`),
    ).toBe("t");
  });
});

// keep the unused import honest for type checking of Browser in helper signatures
export type _Browser = Browser;
