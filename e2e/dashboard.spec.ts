import { expect, test, type Page } from "@playwright/test";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-255] PRD 11.4 scenarios 2 and 3 on the dashboard, as a guest: the first view shows real numbers that equal the API's,
 * a pipeline stage move changes the pipeline cards, and completing an overdue task changes the overdue card and the list
 * behind it, and both survive a reload.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

const kpi = (page: Page, label: string) =>
  page
    .getByRole("region", { name: "Key numbers" })
    .getByRole("link", { name: new RegExp(`^${label}\\s`) });
const valueOf = async (page: Page, label: string) =>
  (await kpi(page, label).innerText())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[1];
const apiDashboard = async (page: Page) =>
  (await (await page.request.get("/api/v1/dashboard")).json()).data;

test("a guest's first dashboard shows meaningful numbers, a stage move and a completed task change them, and a reload agrees", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  // the shell's footer carries the standing fictional-data note on every guest page, this one included
  await expect(page.getByRole("contentinfo").getByRole("note")).toContainText(
    "fictional demonstration data",
  );

  // first view: every card has a real value, equal to the API's
  await expect(kpi(page, "Active customers")).toBeVisible();
  const api = await apiDashboard(page);
  expect(await valueOf(page, "Active customers")).toBe(String(api.activeCustomers));
  expect(await valueOf(page, "Open opportunities")).toBe(String(api.openOpportunities));
  expect(await valueOf(page, "Overdue tasks")).toBe(String(api.overdueTasks));
  expect(await valueOf(page, "Due in the next 7 days")).toBe(String(api.tasksDueNext7Days));
  expect(api.pipelineCents).toBeGreaterThan(0);
  expect(api.overdueTasks).toBeGreaterThan(0);
  expect(await valueOf(page, "Pipeline")).toMatch(/^\$[\d,]+$/);

  // scenario 3: complete an overdue task from the dashboard
  const overdueBefore = api.overdueTasks as number;
  const overdueList = page.getByRole("region", { name: "Overdue" });
  const firstTask = overdueList.getByRole("listitem").first();
  const title = await firstTask.locator("span.font-medium").innerText();
  await firstTask.getByRole("button", { name: /complete/ }).click();
  await expect(kpi(page, "Overdue tasks")).toHaveAccessibleName(
    new RegExp(`^Overdue tasks\\s*${overdueBefore - 1}`),
  );
  await expect(overdueList.getByText(title, { exact: true })).toHaveCount(0);

  // scenario 2: move an open deal to Won on the board; the open pipeline drops
  const pipelineBefore = (await apiDashboard(page)).pipelineCents as number;
  await page.goto("/app/opportunities?view=board");
  const select = page.getByLabel(/^Move .* to another stage$/).first();
  const dealOptions = await page.getByLabel(/^Move .* to another stage$/).all();
  let moved = false;
  for (const candidate of dealOptions) {
    if ((await candidate.inputValue()) === "negotiation") {
      await candidate.selectOption("won");
      moved = true;
      break;
    }
  }
  if (!moved) await select.selectOption("won");
  await expect
    .poll(async () => (await apiDashboard(page)).pipelineCents, { timeout: 15_000 })
    .toBeLessThan(pipelineBefore);

  // back on the dashboard, a reload shows the new numbers (never the stale ones)
  await page.goto("/app");
  const fresh = await apiDashboard(page);
  await expect(kpi(page, "Overdue tasks")).toHaveAccessibleName(
    new RegExp(`^Overdue tasks\\s*${fresh.overdueTasks}`),
  );
  expect(fresh.overdueTasks).toBe(overdueBefore - 1);
  expect(fresh.pipelineCents).toBeLessThan(pipelineBefore);
  await expect(kpi(page, "Open opportunities")).toHaveAccessibleName(
    new RegExp(`^Open opportunities\\s*${fresh.openOpportunities}`),
  );

  // the card leads to the list it counts
  await kpi(page, "Overdue tasks").click();
  await expect(page).toHaveURL(/\/app\/tasks\?overdue=true/);
  await expect(page.getByRole("checkbox", { name: "Overdue" })).toBeChecked();
});

test("the 'due in the next 7 days' card opens the tasks list with that filter on", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app");
  await expect(kpi(page, "Due in the next 7 days")).toBeVisible();
  const count = (await apiDashboard(page)).tasksDueNext7Days as number;
  await kpi(page, "Due in the next 7 days").click();
  await expect(page).toHaveURL(/soon=true/);
  await expect(page.getByRole("checkbox", { name: "Due in the next 7 days" })).toBeChecked();
  await expect(page.getByText(new RegExp(`of ${count}$`))).toBeVisible();
});

test("at 375px the dashboard has no horizontal scrolling and the cards stay readable", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 800 },
    baseURL: "http://localhost:3111",
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app");
  await expect(kpi(page, "Active customers")).toBeVisible();
  await expect(page.getByRole("region", { name: "Overdue" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.E2E_SHOTS)
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/dashboard-375.png`, fullPage: true });
  await trackBrowserUser(context);
  await context.close();
});

const STAGES: Array<[string, string]> = [
  ["new", "New"],
  ["qualified", "Qualified"],
  ["proposal", "Proposal"],
  ["negotiation", "Negotiation"],
  ["won", "Won"],
  ["lost", "Lost"],
];
const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const barText = (byStage: Record<string, { count: number; amountCents: number }>) =>
  STAGES.map(
    ([key]) =>
      `${byStage[key].count} ${byStage[key].count === 1 ? "deal" : "deals"}, ${money(byStage[key].amountCents)}`,
  );

test("[SIT-256] the stage chart draws the API's numbers, follows a stage move, and has an equal table; recent activity lists 10 events", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app");
  const heading = page.getByRole("heading", { name: "Opportunities by stage" });
  await expect(heading).toBeVisible();
  const chart = page.locator("section[aria-labelledby=dash-stage] svg.recharts-surface");
  await expect(chart).toBeVisible({ timeout: 15_000 });

  const before = (await apiDashboard(page)).opportunitiesByStage;
  for (const text of barText(before))
    await expect(chart.getByText(text, { exact: true })).toBeVisible();
  for (const [, label] of STAGES)
    await expect(chart.getByText(label, { exact: true })).toBeVisible();

  // the table alternative has exactly the same rows
  await page.getByRole("button", { name: "View as table" }).click();
  const table = page.getByRole("table", { name: /Opportunities by stage/ });
  for (const [key, label] of STAGES) {
    const row = table.getByRole("row", { name: new RegExp(`^${label}\\b`) });
    await expect(row.getByRole("cell").first()).toHaveText(String(before[key].count));
  }
  await page.getByRole("button", { name: "View as chart" }).click();

  // a stage move changes the chart after a reload
  await page.goto("/app/opportunities?view=board");
  await page
    .getByLabel(/^Move .* to another stage$/)
    .first()
    .waitFor();
  const options = await page.getByLabel(/^Move .* to another stage$/).all();
  for (const candidate of options) {
    if ((await candidate.inputValue()) === "proposal") {
      await candidate.selectOption("negotiation");
      break;
    }
  }
  await expect
    .poll(async () => (await apiDashboard(page)).opportunitiesByStage.negotiation.count, {
      timeout: 15_000,
    })
    .toBe(before.negotiation.count + 1);
  await page.goto("/app");
  const after = (await apiDashboard(page)).opportunitiesByStage;
  const chart2 = page.locator("section[aria-labelledby=dash-stage] svg.recharts-surface");
  await expect(chart2).toBeVisible({ timeout: 15_000 });
  for (const text of barText(after))
    await expect(chart2.getByText(text, { exact: true })).toBeVisible();

  // recent activity
  const activity = page.getByRole("region", { name: "Recent activity" });
  await expect(activity.getByRole("listitem")).toHaveCount(10);
  await expect(activity.getByRole("link", { name: /View all/ })).toHaveAttribute(
    "href",
    "/app/activity",
  );
});
