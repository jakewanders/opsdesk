import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PROBABILITY, weightedAmountCents } from "../src/lib/domain/pipeline";
import { formatUsd } from "../src/lib/money/format";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-259] The dashboard follows what a guest does, by amounts computed from the deal itself (never a snapshot of a live
 * number): a stage move changes the weighted pipeline by the exact rounded difference, Won removes the amount from the
 * pipeline, completing an overdue task, archiving and restoring a customer each move one card by one, and Recent activity
 * lists the new events at the top, newest first. Each test starts from a cold browser context with a fresh demo session.
 */
test.afterAll(cleanUp);

type Dash = {
  activeCustomers: number;
  openOpportunities: number;
  pipelineCents: number;
  weightedPipelineCents: number;
  overdueTasks: number;
  opportunitiesByStage: Record<string, { count: number }>;
  recentActivity: Array<{ summary: string }>;
};
const api = async <T>(page: Page, path: string) =>
  (await (await page.request.get(`/api/v1${path}`)).json()) as T;
const dashboard = async (page: Page) => (await api<{ data: Dash }>(page, "/dashboard")).data;
const card = (page: Page, label: string) =>
  page
    .getByRole("region", { name: "Key numbers" })
    .getByRole("link", { name: new RegExp(`^${label}\\s`) });
const cardValue = async (page: Page, label: string) =>
  (await card(page, label).innerText())
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)[1];

test("moving a deal and closing it changes pipeline and weighted pipeline by the exact computed amounts, on the cards and in the chart", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: "http://localhost:3111" });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });

  // rounding rule: a 3-cent deal at 50% is 1.5 cents, which rounds half UP to 2 (truncating would give 1)
  const baseline = await dashboard(page);
  const created = await page.evaluate(async () => {
    const customer = (await (await fetch("/api/v1/customers?limit=1")).json()).data[0].id as string;
    const res = await fetch("/api/v1/opportunities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerId: customer,
        title: "Half cent probe",
        amountCents: 3,
        stage: "proposal",
      }),
    });
    return res.status;
  });
  expect(created).toBe(201);
  const start = await dashboard(page);
  expect(start.pipelineCents).toBe(baseline.pipelineCents + 3);
  expect(start.weightedPipelineCents).toBe(
    baseline.weightedPipelineCents + weightedAmountCents(3, DEFAULT_PROBABILITY.proposal),
  );
  expect(weightedAmountCents(3, 50)).toBe(2);
  const deals = (
    await api<{
      data: Array<{
        id: string;
        title: string;
        stage: string;
        amountCents: number;
        probabilityPercent: number;
      }>;
    }>(page, "/opportunities?limit=100")
  ).data;
  const deal = deals.find((d) => d.stage === "proposal")!;
  expect(deal).toBeTruthy();
  const weightedNow = weightedAmountCents(deal.amountCents, deal.probabilityPercent);
  const weightedNegotiation = weightedAmountCents(
    deal.amountCents,
    DEFAULT_PROBABILITY.negotiation,
  );

  const moveTo = async (stage: "negotiation" | "won") => {
    await page.goto("/app/opportunities?view=board");
    await page.getByLabel(`Move ${deal.title} to another stage`).selectOption(stage);
  };

  // Proposal -> Negotiation: still open, so the pipeline is unchanged and the weighted pipeline moves by the rounded difference
  await moveTo("negotiation");
  await expect
    .poll(async () => (await dashboard(page)).weightedPipelineCents, { timeout: 15_000 })
    .toBe(start.weightedPipelineCents - weightedNow + weightedNegotiation);
  const afterNegotiation = await dashboard(page);
  expect(afterNegotiation.pipelineCents).toBe(start.pipelineCents);
  expect(afterNegotiation.openOpportunities).toBe(start.openOpportunities);
  await page.goto("/app");
  await expect(card(page, "Weighted pipeline")).toContainText(
    formatUsd(afterNegotiation.weightedPipelineCents, { whole: true }),
  );
  await expect(card(page, "Pipeline")).toContainText(
    formatUsd(start.pipelineCents, { whole: true }),
  );

  // Negotiation -> Won: leaves the open pipeline entirely
  await moveTo("won");
  await expect
    .poll(async () => (await dashboard(page)).pipelineCents, { timeout: 15_000 })
    .toBe(start.pipelineCents - deal.amountCents);
  const won = await dashboard(page);
  expect(won.weightedPipelineCents).toBe(start.weightedPipelineCents - weightedNow);
  expect(won.openOpportunities).toBe(start.openOpportunities - 1);
  expect(won.opportunitiesByStage.won.count).toBe(start.opportunitiesByStage.won.count + 1);
  expect(won.opportunitiesByStage.proposal.count).toBe(
    start.opportunitiesByStage.proposal.count - 1,
  );
  await page.goto("/app");
  expect(await cardValue(page, "Open opportunities")).toBe(String(start.openOpportunities - 1));
  await expect(card(page, "Pipeline")).toContainText(formatUsd(won.pipelineCents, { whole: true }));
  await expect(card(page, "Weighted pipeline")).toContainText(
    formatUsd(won.weightedPipelineCents, { whole: true }),
  );
  // the chart's text for Won is the API's count and amount, and the screen-reader table agrees
  const chart = page.locator("section[aria-labelledby=dash-stage] svg.recharts-surface");
  await expect(
    chart.getByText(new RegExp(`^${won.opportunitiesByStage.won.count} deals?, \\$`)),
  ).toBeVisible({ timeout: 15_000 });

  // the two moves are the newest events, newest first
  const feed = (await dashboard(page)).recentActivity.map((e) => e.summary);
  expect(feed[0]).toContain(`moved "${deal.title}" from Negotiation to Won`);
  expect(feed[1]).toContain(`moved "${deal.title}" from Proposal to Negotiation`);
  await trackBrowserUser(context);
  await context.close();
});

test("completing an overdue task, archiving and restoring a customer each move one card by one, and Recent activity shows them newest first", async ({
  browser,
}) => {
  const context = await browser.newContext({ baseURL: "http://localhost:3111" });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  const start = await dashboard(page);
  const customers = (
    await api<{ data: Array<{ id: string; displayName: string }> }>(
      page,
      "/customers?limit=100&sort=display_name&order=asc",
    )
  ).data;
  const customer = customers[0];

  // archive through the confirmation dialog: Active customers drops by one
  await page.goto(`/app/customers/${customer.id}`);
  await page.getByRole("button", { name: "Archive" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Archive customer" }).click();
  await expect(page.getByText("This customer is archived.")).toBeVisible();
  await expect
    .poll(async () => (await dashboard(page)).activeCustomers, { timeout: 15_000 })
    .toBe(start.activeCustomers - 1);
  await page.goto("/app");
  expect(await cardValue(page, "Active customers")).toBe(String(start.activeCustomers - 1));

  // restore: back to the starting number
  await page.goto(`/app/customers/${customer.id}`);
  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("This customer is archived.")).toBeHidden();
  await expect
    .poll(async () => (await dashboard(page)).activeCustomers, { timeout: 15_000 })
    .toBe(start.activeCustomers);

  // complete an overdue task from the dashboard: Overdue drops by one and the task leaves the list and the API's overdue list
  await page.goto("/app");
  const overdue = page.getByRole("region", { name: "Overdue" });
  const first = overdue.getByRole("listitem").first();
  const title = await first.locator("span.font-medium").innerText();
  await first.getByRole("button", { name: /complete/ }).click();
  await expect(overdue.getByText(title, { exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await dashboard(page)).overdueTasks, { timeout: 15_000 })
    .toBe(start.overdueTasks - 1);
  const overdueList = (
    await api<{ data: Array<{ title: string }> }>(page, "/tasks?overdue=true&limit=100")
  ).data;
  expect(overdueList.map((t) => t.title)).not.toContain(title);
  expect(await cardValue(page, "Overdue tasks")).toBe(String(start.overdueTasks - 1));

  // Recent activity: the newest events are at the top, in the order they happened
  await page.reload();
  const activity = page.getByRole("region", { name: "Recent activity" });
  const items = activity.locator(":scope ol > li");
  await expect(items.first()).toContainText(`completed task "${title}"`);
  await expect(items.nth(1)).toContainText(`restored customer "${customer.displayName}"`);
  await expect(items.nth(2)).toContainText(`archived customer "${customer.displayName}"`);
  await trackBrowserUser(context);
  await context.close();
});
