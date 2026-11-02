import { expect, test } from "@playwright/test";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-257] PRD 11.4 scenarios 1 to 3: what a guest does in the UI (create a customer, move a deal, complete a task)
 * appears in the activity feed, and the feed's filters and page round-trip through the URL.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

test("changes made in the UI show up in the activity feed; filters and paging survive a reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });

  // scenario 1: create a customer
  const name = `Feed Co ${Date.now()}`;
  await page.goto("/app/customers/new");
  await expect(page.getByRole("heading", { name: /Add customer/ })).toBeVisible();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();

  // scenario 2: move a deal's stage on the board
  await page.goto("/app/opportunities?view=board");
  await page
    .getByLabel(/^Move .* to another stage$/)
    .first()
    .waitFor();
  const selects = await page.getByLabel(/^Move .* to another stage$/).all();
  let dealTitle = "";
  for (const select of selects) {
    if ((await select.inputValue()) === "proposal") {
      dealTitle =
        ((await select.getAttribute("id")) ?? "") &&
        (await page.locator(`label[for="${await select.getAttribute("id")}"]`).innerText()).replace(
          /^Move | to another stage$/g,
          "",
        );
      await select.selectOption("negotiation");
      break;
    }
  }
  expect(dealTitle).not.toBe("");
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/v1/activity?action=stage_changed&limit=1")).json())
          .data[0].summary,
      { timeout: 15_000 },
    )
    .toContain("from Proposal to Negotiation");

  // scenario 3: complete a task from the dashboard
  await page.goto("/app");
  const overdue = page.getByRole("region", { name: "Overdue" });
  const taskTitle = await overdue
    .getByRole("listitem")
    .first()
    .locator("span.font-medium")
    .innerText();
  await overdue
    .getByRole("listitem")
    .first()
    .getByRole("button", { name: /complete/ })
    .click();
  await expect(overdue.getByText(taskTitle, { exact: true })).toHaveCount(0);

  // the feed, newest first, has all three
  await page.goto("/app/activity");
  const feed = page.getByRole("list", { name: "Activity" });
  await expect(feed.getByRole("listitem").first()).toBeVisible();
  await expect(feed).toContainText(`created customer "${name}"`);
  await expect(feed).toContainText(`moved "${dealTitle}" from Proposal to Negotiation`);
  await expect(feed).toContainText(`completed task "${taskTitle}"`);
  await expect(feed.getByRole("listitem").first()).toContainText("completed task");

  // a summary links to its (active) record
  await feed.getByRole("link", { name: new RegExp(`created customer "${name}"`) }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();

  // filters round-trip through the URL
  await page.goto("/app/activity");
  await page.getByLabel("Records").selectOption("task");
  await expect(page).toHaveURL(/entityType=task/);
  await expect(feed.getByRole("listitem").first()).toContainText("task");
  await page.reload();
  await expect(page.getByLabel("Records")).toHaveValue("task");
  await expect(feed.getByRole("listitem").first()).toBeVisible();
  const rows = await feed.locator(":scope > li").allInnerTexts();
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row).toMatch(/Task/);
  await page.getByLabel("What happened").selectOption("completed");
  await expect(page).toHaveURL(/action=completed/);
  await page.reload();
  await expect(page.getByLabel("What happened")).toHaveValue("completed");
  await expect(feed.getByRole("listitem").first()).toBeVisible();
  for (const row of await feed.locator(":scope > li").allInnerTexts())
    expect(row).toContain("Completed");

  // paging: the unfiltered feed has more than one page at 10 per page, and the page number survives a reload
  await page.goto("/app/activity?limit=10");
  await expect(page.getByText(/^Showing 1 to 10 of \d+$/)).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByText(/^Showing 11 to \d+ of \d+$/)).toBeVisible();

  // an archived customer shows as archived and stays linkable
  const archivedName = `Gone Co ${Date.now()}`;
  // a browser fetch (the app's own origin), so the API's same-origin check passes
  const id = await page.evaluate(async (displayName) => {
    const made = await (
      await fetch("/api/v1/customers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName }),
      })
    ).json();
    const res = await fetch(`/api/v1/customers/${made.data.id}`, { method: "DELETE" });
    if (res.status !== 204) throw new Error(`archive failed: ${res.status}`);
    return made.data.id as string;
  }, archivedName);
  await page.goto("/app/activity");
  const archivedItem = feed
    .getByRole("listitem")
    .filter({ hasText: `archived customer "${archivedName}"` });
  await expect(archivedItem.getByText("Archived", { exact: true }).first()).toBeVisible();
  await archivedItem.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/app/customers/${id}`));
});
