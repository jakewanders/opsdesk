import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./support/axe";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-268] PRD 9.7 / US-06 in a real browser, as a demo guest (the demo workspace has a history to report on): the charts draw from
 * the API's data, the range control changes every chart and the URL, a shared URL reproduces the view, each chart says what it is
 * counted on, the numbers in the tables equal the API's, export downloads, and the page fits a phone and passes axe in both themes.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}
const apiReport = async (page: Page, qs: string) =>
  (await (await page.request.get(`/api/v1/reports${qs}`)).json()).data;
/** Choose a range the way a person does: click its label (the radio itself is visually hidden behind it). */
const pick = (page: Page, label: string) =>
  page.locator("label", { hasText: new RegExp(`^${label}$`) }).click();
const CHART = ".recharts-wrapper > svg.recharts-surface";
/** How many charts the page draws for a report: an event chart with nothing in the range is a sentence instead. */
const drawn = (r: {
  buckets: Array<Record<string, number>>;
  customersBySource: Record<string, number>;
  opportunitiesByStage: Record<string, { count: number }>;
}) =>
  Number(
    sum(r, "opportunitiesCreated") + sum(r, "opportunitiesWon") + sum(r, "opportunitiesLost") > 0,
  ) +
  Number(sum(r, "tasksCompleted") > 0) +
  Number(Object.values(r.customersBySource).some((n) => n > 0)) +
  Number(Object.values(r.opportunitiesByStage).some((s) => s.count > 0));
const sum = (r: { buckets: Array<Record<string, number>> }, k: string) =>
  r.buckets.reduce((n, b) => n + b[k], 0);

test("the reports page draws from the API, the range changes every chart and the URL, and a shared URL reproduces it", async ({
  page,
}) => {
  await enterDemo(page);
  await page.goto("/app/reports");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("note").filter({ hasText: "fictional demonstration data" }).first(),
  ).toBeVisible();

  // the exact range, in words, with the zone; the same days the API reports
  const api30 = await apiReport(page, "?range=30");
  await expect(page.getByRole("status").filter({ hasText: "30 days, by day" })).toContainText(
    api30.timeZone,
  );
  expect(api30.range.days).toBe(30);

  // every chart is drawn (Recharts renders real SVG) and says what it is counted on
  const trend = page.locator("section[aria-labelledby='rep-trend-title']");
  await expect(page.locator(CHART)).toHaveCount(drawn(api30), { timeout: 20_000 });
  await expect(page.getByText("Counted on the day it happened")).toHaveCount(3);
  await expect(page.getByText("As of right now")).toHaveCount(1);

  // the table behind a chart carries the API's numbers
  await trend.getByRole("button", { name: "View as table" }).click();
  const total = trend.getByRole("row", { name: /^Total/ });
  await expect(total.getByRole("cell").nth(0)).toHaveText(
    String(sum(api30, "opportunitiesCreated")),
  );
  await expect(total.getByRole("cell").nth(1)).toHaveText(String(sum(api30, "opportunitiesWon")));
  await expect(total.getByRole("cell").nth(2)).toHaveText(String(sum(api30, "opportunitiesLost")));
  await trend.getByRole("button", { name: "View as chart" }).click();

  // range 90: every chart follows, and so does the URL
  await pick(page, "90 days");
  await expect(page).toHaveURL(/\/app\/reports\?range=90$/);
  const api90 = await apiReport(page, "?range=90");
  await expect(page.getByRole("status").filter({ hasText: "90 days, by week" })).toBeVisible();
  await trend.getByRole("button", { name: "View as table" }).click();
  await expect(
    trend
      .getByRole("row", { name: /^Total/ })
      .getByRole("cell")
      .nth(0),
  ).toHaveText(String(sum(api90, "opportunitiesCreated")));
  await expect(trend.getByRole("row")).toHaveCount(api90.buckets.length + 2); // header + buckets + total

  // a shared URL reproduces the view in a fresh load
  await page.goto("/app/reports?range=7");
  await expect(page.getByRole("radio", { name: "7 days" })).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "7 days, by day" })).toBeVisible();

  // custom dates
  await pick(page, "Custom");
  await expect(page).toHaveURL(/range=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
  await page.getByLabel("To (included)").fill("2000-01-01");
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page.locator("form [role=alert]")).toContainText(
    "The end date is before the start date.",
  );
  const from = await page.getByLabel("From").inputValue();
  await page.getByLabel("To (included)").fill(from);
  await page.getByRole("button", { name: "Apply dates" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 day, by day" })).toBeVisible();
});

test("Export CSV downloads the range on screen", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/app/reports?range=90");
  await expect(page.locator(CHART).first()).toBeVisible({ timeout: 20_000 });
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^reports-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = readFileSync((await file.path()) as string, "utf8");
  expect(text.split("\r\n")[0]).toBe(
    "section,key,period_start,period_end,metric,value,exported_at,Sample / fictional data",
  );
  expect(text).toContain("deals_by_stage_now,won");
});

test("the page passes axe in light and dark and fits a phone", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/app/reports");
  await expect(page.locator(CHART).first()).toBeVisible({ timeout: 20_000 });
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.locator(CHART).first()).toBeVisible({ timeout: 20_000 });
  expect(await axeViolations(page)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.reload();
  await expect(page.locator(CHART).first()).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole("radio", { name: "7 days" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
});
