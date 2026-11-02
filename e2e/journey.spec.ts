import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-262] The primary demo journey from a cold browser (a brand-new context: no cookies, no storage, no cache), with every
 * step timed: landing, Try Live Demo, the seeded dashboard, create / update / archive a customer, move an opportunity,
 * complete a task, and the dashboard showing the changes. Times are written to test-results/journey-times.json.
 * The budget for "dashboard usable" is 3 s on warm services (local stack, production build).
 */
test.afterAll(cleanUp);

const toast = (page: Page, text: RegExp | string) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
const dash = async (page: Page) =>
  (await (await page.request.get("/api/v1/dashboard")).json()).data;

test("landing to a changed dashboard, timed, from a cold browser", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ baseURL: "http://localhost:3111" });
  const page = await context.newPage();
  const times: Record<string, number> = {};
  let interactions = 0;
  let challengeDone = 0; // when the anonymous sign-in answered: everything before it is Cloudflare's Turnstile check
  page.on("requestfinished", (r) => {
    if (r.url().includes("/auth/v1/signup") && !challengeDone) challengeDone = Date.now();
  });
  const step = async (name: string, fn: () => Promise<void>) => {
    const t0 = Date.now();
    await fn();
    times[name] = Date.now() - t0;
  };

  await step("landing visible", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
  // one click starts the demo; the seeded dashboard must be usable without further interaction
  const clicked = Date.now();
  await step("try live demo to usable dashboard", async () => {
    interactions++;
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("region", { name: "Overdue" })).toBeVisible();
  });
  expect(interactions).toBeLessThanOrEqual(3);
  const start = await dash(page);
  expect(start.activeCustomers).toBe(15);

  // create, update, archive a customer (each with its success toast)
  const name = `Journey Co ${Date.now()}`;
  await step("create customer", async () => {
    await page.getByRole("link", { name: "Add customer" }).first().click();
    await page.getByLabel("Display name").fill(name);
    await page.getByLabel("Email").fill("journey@example.com");
    await page.getByRole("button", { name: "Add customer" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
    await expect(toast(page, /Customer (added|created)/)).toBeVisible();
  });
  await step("update customer", async () => {
    await page.getByRole("link", { name: "Edit" }).click();
    await expect(page.getByRole("heading", { name: new RegExp(`^Edit ${name}`) })).toBeVisible();
    await page.getByLabel("Phone").fill("(202) 555-0142");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("(202) 555-0142")).toBeVisible();
    await expect(toast(page, /Customer (updated|saved)|Changes saved/)).toBeVisible();
  });
  await step("archive customer", async () => {
    await page.getByRole("button", { name: "Archive" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Archive customer" }).click();
    await expect(page.getByText("This customer is archived.")).toBeVisible();
    await expect(toast(page, /Customer archived/)).toBeVisible();
  });

  // move an opportunity (the stage menu on the board)
  const before = await dash(page);
  const deals = (await (await page.request.get("/api/v1/opportunities?limit=100")).json())
    .data as Array<{ title: string; stage: string }>;
  const deal = deals.find((d) => d.stage === "proposal")!;
  await step("move opportunity", async () => {
    await page.goto("/app/opportunities?view=board");
    await page.getByLabel(`Move ${deal.title} to another stage`).selectOption("negotiation");
    await expect
      .poll(async () => (await dash(page)).opportunitiesByStage.negotiation.count, {
        timeout: 15_000,
      })
      .toBe(before.opportunitiesByStage.negotiation.count + 1);
  });

  // complete a task from the dashboard
  await step("complete task", async () => {
    await page.goto("/app");
    const first = page.getByRole("region", { name: "Overdue" }).getByRole("listitem").first();
    const title = await first.locator("span.font-medium").innerText();
    await first.getByRole("button", { name: /complete/ }).click();
    await expect(toast(page, new RegExp(`Task completed`))).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Overdue" }).getByText(title, { exact: true }),
    ).toHaveCount(0);
  });

  // the dashboard shows the changes
  await step("dashboard shows the changes", async () => {
    await page.goto("/app");
    const after = await dash(page);
    expect(after.overdueTasks).toBe(before.overdueTasks - 1);
    expect(after.activeCustomers).toBe(start.activeCustomers); // created, then archived
    await expect(
      page
        .getByRole("region", { name: "Key numbers" })
        .getByRole("link", { name: new RegExp(`^Overdue tasks\\s*${after.overdueTasks}`) }),
    ).toBeVisible();
    const feed = page.getByRole("region", { name: "Recent activity" }).locator(":scope ol > li");
    await expect(feed.first()).toContainText("completed task");
  });

  // the part this app controls: from the sign-in answering (the Turnstile check is Cloudflare's) to a usable dashboard
  times["turnstile check (Cloudflare)"] = challengeDone - clicked;
  times["after the check: sign-in answered to usable dashboard"] =
    times["try live demo to usable dashboard"] - (challengeDone - clicked);

  // a returning guest (the session cookie exists): /demo sends them straight to their dashboard
  const warm = await context.newPage();
  const w0 = Date.now();
  await warm.goto("/demo");
  await expect(warm.getByRole("region", { name: "Key numbers" })).toBeVisible({ timeout: 30_000 });
  await expect(warm.getByRole("region", { name: "Overdue" })).toBeVisible();
  times["returning guest: /demo to usable dashboard"] = Date.now() - w0;
  await warm.close();

  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    "test-results/journey-times.json",
    JSON.stringify({ times, interactions }, null, 1),
  );
  console.log("JOURNEY " + JSON.stringify(times));
  // Budgets. A returning guest and everything this app controls must be well inside 3 s. The first visit also waits for
  // Cloudflare's Turnstile check (about 1.5 s, outside this app); its total is recorded and held to a loose 5 s so a real
  // regression shows, while the 3 s target is reported against the numbers in docs/PROGRESS.md.
  expect(times["returning guest: /demo to usable dashboard"]).toBeLessThan(3000);
  expect(times["after the check: sign-in answered to usable dashboard"]).toBeLessThan(2000);
  expect(times["try live demo to usable dashboard"]).toBeLessThan(5000);
  await trackBrowserUser(context);
  await context.close();
});
