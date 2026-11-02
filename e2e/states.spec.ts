import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  api as apiAs,
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  trackBrowserUser,
} from "./support/local";

/**
 * [SIT-262] Loading, empty and error states on the P0 pages, and failure handling on the demo bootstrap and on mutations:
 * an API 500, a 429 demo cap, going offline, and a slow network. Every failure must be named in words with a way to recover
 * (and a request id where the API sent one), never a raw error, a blank screen or invented data.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

const RID = "req-test-4711";
const failure = (status: number, code: string, message: string) => ({
  status,
  contentType: "application/json",
  headers: { "x-request-id": RID },
  body: JSON.stringify({ error: { code, message, requestId: RID } }),
});
const toast = (page: Page, text: RegExp | string) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
const RAW =
  /Unhandled|\[object|undefined|NaN|Traceback|at \w+\.\w+ \(|TypeError|<!DOCTYPE|"error":/;
async function cleanPage(page: Page, where: string) {
  const text = await page.locator("body").innerText();
  expect(text, `${where}: raw error text on the page`).not.toMatch(RAW);
  expect(text.trim().length, `${where}: blank page`).toBeGreaterThan(40);
}
async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

test.describe("demo bootstrap failures", () => {
  test("an API 500 is named and retryable, and the retry gets in", async ({ page }) => {
    await page.route("**/api/v1/demo/bootstrap", (r) =>
      r.fulfill(failure(500, "INTERNAL", "boom")),
    );
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    const alert = page.locator("[role=alert]:not(#__next-route-announcer__)");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: "The demo is unavailable right now" }),
    ).toBeVisible();
    await expect(alert).toContainText(`Reference: ${RID}`);
    await expect(alert).toContainText("Try again");
    await cleanPage(page, "/demo after a 500");
    await page.unroute("**/api/v1/demo/bootstrap");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/app/, { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  });

  test("a 429 (the demo is busy) says so, creates nothing and can be retried", async ({ page }) => {
    await page.route("**/api/v1/demo/bootstrap", (r) =>
      r.fulfill(failure(429, "RATE_LIMITED", "slow down")),
    );
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    const alert = page.locator("[role=alert]:not(#__next-route-announcer__)");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "The demo is busy right now" })).toBeVisible();
    await expect(alert).toContainText("Nothing was created");
    await cleanPage(page, "/demo after a 429");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("losing the network during sign-in is named, and the retry works once it is back", async ({
    page,
  }) => {
    // the demo page is loaded; then every request to the auth service and the bootstrap endpoint fails as if offline
    const drop = (r: { abort: (reason: string) => Promise<void> }) =>
      r.abort("internetdisconnected");
    await page.route("**/auth/v1/**", drop);
    await page.route("**/api/v1/demo/bootstrap", drop);
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    const alert = page.locator("[role=alert]:not(#__next-route-announcer__)");
    await expect(alert).toBeVisible({ timeout: 45_000 });
    await expect(alert).toContainText(/could not reach|unavailable|try again/i);
    await cleanPage(page, "/demo offline");
    await page.unroute("**/auth/v1/**");
    await page.unroute("**/api/v1/demo/bootstrap");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForURL(/\/app/, { timeout: 60_000 });
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  });

  test("a slow bootstrap shows progress, then succeeds", async ({ page }) => {
    await page.route("**/api/v1/demo/bootstrap", async (r) => {
      await new Promise((res) => setTimeout(res, 3000));
      await r.continue();
    });
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    await expect(page.getByRole("status").first()).toBeVisible({ timeout: 15_000 });
    await cleanPage(page, "/demo while waiting");
    await page.waitForURL(/\/app/, { timeout: 60_000 });
  });
});

test.describe("loading and error states on the P0 pages", () => {
  async function failThenRecover(
    page: Page,
    urlPart: string,
    trigger: () => Promise<void>,
    title: RegExp,
    ready: () => Promise<void>,
  ) {
    await page.route(`**${urlPart}**`, (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    await trigger();
    const alert = page
      .locator("[role=alert]:not(#__next-route-announcer__)")
      .filter({ hasText: title });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(RID); // the request id is shown so it can be quoted
    await expect(alert.getByRole("button", { name: /Try again|Retry/ })).toBeVisible();
    await cleanPage(page, title.source);
    await page.unroute(`**${urlPart}**`);
    await alert.getByRole("button", { name: /Try again|Retry/ }).click();
    await ready();
  }

  test("opportunity list, pipeline board, tasks, activity and customers: a skeleton while loading, a specific alert with the request id on failure, recovery by retry", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await enterDemo(page);

    // a slow network: the activity feed and the opportunity list show their loading state first
    await page.route("**/api/v1/activity**", async (r) => {
      await new Promise((res) => setTimeout(res, 2000));
      await r.continue();
    });
    await page.goto("/app/activity");
    await expect(page.getByRole("status").filter({ hasText: "Loading activity" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Activity" })).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/v1/activity**");
    await page.route("**/api/v1/opportunities?**", async (r) => {
      await new Promise((res) => setTimeout(res, 2000));
      await r.continue();
    });
    await page.goto("/app/opportunities?view=list");
    await expect(
      page.getByRole("status").filter({ hasText: /Loading opportunities/ }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 20_000 });
    await page.unroute("**/api/v1/opportunities?**");

    // activity
    await page.route("**/api/v1/activity**", (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    await page.goto("/app/activity");
    await expect(
      page.getByRole("alert").filter({ hasText: "Activity could not be loaded" }),
    ).toContainText(RID);
    await cleanPage(page, "activity error");
    await page.unroute("**/api/v1/activity**");
    await page.getByRole("button", { name: /Try again|Retry/ }).click();
    await expect(page.getByRole("list", { name: "Activity" })).toBeVisible({ timeout: 20_000 });

    // opportunity list
    await page.route("**/api/v1/opportunities?**", (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    await page.goto("/app/opportunities?view=list");
    await expect(
      page.getByRole("alert").filter({ hasText: "Opportunities could not be loaded" }),
    ).toContainText(RID);
    await cleanPage(page, "opportunity list error");
    await page.unroute("**/api/v1/opportunities?**");
    await page
      .getByRole("button", { name: /Try again|Retry/ })
      .first()
      .click();
    await expect(page.getByRole("table")).toBeVisible({ timeout: 20_000 });

    // pipeline board
    await page.route("**/api/v1/opportunities**", (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    await page.goto("/app/opportunities?view=board");
    await expect(page.getByText(/could not be loaded/i).first()).toBeVisible({ timeout: 20_000 });
    await cleanPage(page, "pipeline board error");
    await page.unroute("**/api/v1/opportunities**");

    // customers and tasks read their first page (and every filtered page) on the server, so their error alerts only appear when
    // a refetch fails; those alerts are covered by the component tests (customers-view, tasks-view)
  });

  test("the dashboard: a failed refresh says so with the request id and recovers", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app");
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
    await page.route("**/api/v1/dashboard", (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    // completing a task refreshes the dashboard's numbers, which now fail
    await page
      .getByRole("region", { name: "Overdue" })
      .getByRole("listitem")
      .first()
      .getByRole("button", { name: /complete/ })
      .click();
    const alert = page.getByRole("alert").filter({ hasText: "The dashboard could not be loaded" });
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(RID);
    await cleanPage(page, "dashboard error");
    await page.unroute("**/api/v1/dashboard");
    await alert.getByRole("button", { name: /Try again|Retry/ }).click();
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
  });
});

test("on slow 3G the pages show their loading states, never a blank screen or an error, and finish loading", async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await enterDemo(page);
  const cdp = await context.newCDPSession(page);
  // Chrome's "Slow 3G" preset: 400 ms latency, about 400 kbit/s each way
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: (400 * 1024) / 8,
    uploadThroughput: (400 * 1024) / 8,
  });
  const seen: Record<string, number> = {};
  for (const [path, ready] of [
    ["/app/activity", "ol"],
    ["/app/opportunities?view=list", "table"],
  ] as const) {
    const t0 = Date.now();
    await page.goto(path, { waitUntil: "commit" });
    // while it loads the page is never blank and never shows an error
    await expect(page.locator("body")).toContainText(/\S{3,}/, { timeout: 60_000 });
    const early = await page.locator("body").innerText();
    expect(early, `${path} while loading`).not.toMatch(RAW);
    await expect(page.locator(ready).first()).toBeVisible({ timeout: 120_000 });
    seen[path] = Date.now() - t0;
  }
  console.log("SLOW3G " + JSON.stringify(seen));
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
});

test.describe("mutation failures", () => {
  test("creating a customer: a 500, a 429 demo cap and being offline each keep the form, say what happened and recover", async ({
    page,
    context,
  }) => {
    await enterDemo(page);
    await page.goto("/app/customers/new");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Display name").fill("Failure Co");
    // 500
    await page.route("**/api/v1/customers", (r) =>
      r.request().method() === "POST"
        ? r.fulfill(failure(500, "INTERNAL", "The server could not answer."))
        : r.continue(),
    );
    await page.getByRole("button", { name: "Add customer" }).click();
    const alert = page.locator("[role=alert]:not(#__next-route-announcer__)").first();
    await expect(alert).toBeVisible({ timeout: 20_000 });
    await expect(alert).toContainText(RID);
    await expect(page.getByLabel("Display name")).toHaveValue("Failure Co");
    await cleanPage(page, "customer form after a 500");
    // 429 demo cap
    await page.unroute("**/api/v1/customers");
    await page.route("**/api/v1/customers", (r) =>
      r.request().method() === "POST"
        ? r.fulfill(
            failure(
              429,
              "DEMO_CAP",
              "This demo workspace has reached its limit for customers. Reset the demo to start fresh.",
            ),
          )
        : r.continue(),
    );
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)").first()).toContainText(
      /limit|Reset the demo/i,
      { timeout: 20_000 },
    );
    await cleanPage(page, "customer form after a 429");
    // offline
    await page.unroute("**/api/v1/customers");
    await context.setOffline(true);
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.locator("[role=alert]:not(#__next-route-announcer__)").first()).toContainText(
      /connection|network|offline|reach|try again/i,
      { timeout: 20_000 },
    );
    await expect(page.getByLabel("Display name")).toHaveValue("Failure Co");
    await cleanPage(page, "customer form offline");
    // back online: the same form saves
    await context.setOffline(false);
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("heading", { name: /Failure Co/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(toast(page, /Customer (added|created)/)).toBeVisible();
  });

  test("archiving, moving a deal and completing a task: failures are explained in place and nothing is left half-done", async ({
    page,
  }) => {
    await enterDemo(page);
    const cid = (await (await page.request.get("/api/v1/customers?limit=1")).json()).data[0]
      .id as string;
    // archive: the dialog stays open with the reason and the request id
    await page.goto(`/app/customers/${cid}`);
    await page.route(`**/api/v1/customers/${cid}`, (r) =>
      r.request().method() === "DELETE"
        ? r.fulfill(failure(500, "INTERNAL", "The server could not answer."))
        : r.continue(),
    );
    await page.getByRole("button", { name: "Archive" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Archive customer" }).click();
    await expect(dialog).toContainText(RID, { timeout: 20_000 });
    await expect(page.getByText("This customer is archived.")).toBeHidden();
    await cleanPage(page, "archive dialog after a 500");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.unroute(`**/api/v1/customers/${cid}`);
    // move: the card goes back and the person is told
    const deals = (await (await page.request.get("/api/v1/opportunities?limit=100")).json())
      .data as Array<{ id: string; title: string; stage: string }>;
    const deal = deals.find((d) => d.stage === "proposal")!;
    await page.goto("/app/opportunities?view=board");
    await page.getByLabel(`Move ${deal.title} to another stage`).waitFor();
    await page.route(`**/api/v1/opportunities/${deal.id}/stage`, (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    await page.getByLabel(`Move ${deal.title} to another stage`).selectOption("negotiation");
    await expect(toast(page, /was not moved/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel(`Move ${deal.title} to another stage`)).toHaveValue("proposal");
    await page.unroute(`**/api/v1/opportunities/${deal.id}/stage`);
    // complete: the row stays and the person is told
    await page.goto("/app");
    await page.route("**/api/v1/tasks/*/complete", (r) =>
      r.fulfill(failure(500, "INTERNAL", "The server could not answer.")),
    );
    const first = page.getByRole("region", { name: "Overdue" }).getByRole("listitem").first();
    const title = await first.locator("span.font-medium").innerText();
    await first.getByRole("button", { name: /complete/ }).click();
    await expect(toast(page, /was not completed/)).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole("region", { name: "Overdue" }).getByText(title, { exact: true }),
    ).toBeVisible();
  });

  test("successful changes confirm themselves with a toast naming the record", async ({ page }) => {
    await enterDemo(page);
    const name = `Toast Co ${Date.now()}`;
    await page.goto("/app/customers/new");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Display name").fill(name);
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(toast(page, new RegExp(name))).toBeVisible();
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive customer" }).click();
    await expect(toast(page, new RegExp(`Customer archived[\\s\\S]*${name}`))).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(toast(page, new RegExp(`Customer restored[\\s\\S]*${name}`))).toBeVisible();
  });
});

test.describe("a brand-new real workspace: empty states with a next step, and no invented data", () => {
  async function emptyWorkspace(context: BrowserContext) {
    const owner = await makeUser("empty");
    await makeWorkspace(owner, "Empty Co");
    await signIn(context, owner);
    return owner;
  }

  test("every P0 page explains what is missing and offers the first action", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await emptyWorkspace(context);
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: "Add your first customer" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("link", { name: /Add customer/ }).first()).toBeVisible();
    await cleanPage(page, "empty dashboard");
    // no fake data anywhere: the demo's seeded names and numbers must not appear
    await expect(
      page.getByText(/Rhea Yelverton|Quillmere|Pool service agreement|Send revised quote/),
    ).toHaveCount(0);

    await page.goto("/app/customers");
    await expect(page.getByRole("heading", { name: "No customers yet" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /Add (your first )?customer/i }).first(),
    ).toBeVisible();
    await cleanPage(page, "empty customers");

    await page.goto("/app/opportunities?view=list");
    await expect(page.getByText("No opportunities yet")).toBeVisible();
    await expect(page.getByRole("link", { name: /Create your first opportunity/ })).toBeVisible();
    await cleanPage(page, "empty pipeline list");

    await page.goto("/app/opportunities?view=board");
    await expect(page.getByRole("region", { name: "Pipeline board" })).toBeVisible();
    await expect(page.getByText(/\$[1-9]/)).toHaveCount(0); // no money on an empty board
    await cleanPage(page, "empty board");

    await page.goto("/app/tasks");
    await expect(page.getByRole("heading", { name: "No tasks yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add task/ }).first()).toBeVisible();
    await cleanPage(page, "empty tasks");

    await page.goto("/app/activity");
    await expect(page.getByText(/No activity yet|Nothing has happened/)).toBeVisible();
    await cleanPage(page, "empty activity");

    // the first action works: add a customer from the empty dashboard
    await page.goto("/app");
    await page
      .getByRole("link", { name: /Add customer/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/app\/customers\/new/);
  });
});
