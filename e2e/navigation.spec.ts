import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./support/axe";
import { api, cleanUp, makeUser, makeWorkspace, signIn, type Person } from "./support/local";

/**
 * [SIT-270] PRD F15 / 7.5: a walk through every related-record link (customer, deal, task, quote, activity, dashboard), that going
 * back to a list keeps its filters, that archived targets are marked but still open, that a copied filtered URL reproduces the view
 * in another session of the same workspace, and that the pages pass axe.
 */
let owner: Person;
let org = "";
const ids: Record<string, string> = {};
const data = async (res: Response) => ((await res.json()) as { data: { id: string } }).data;

test.beforeAll(async () => {
  owner = await makeUser("navo");
  org = await makeWorkspace(owner, "E2E Navigation Co");
  const customer = await data(
    await api(owner, "POST", "/customers", org, {
      displayName: "Navwalk Customer",
      tags: ["walk"],
    }),
  );
  await api(owner, "POST", "/customers", org, { displayName: "Other Person" });
  const deal = await data(
    await api(owner, "POST", "/opportunities", org, {
      customerId: customer.id,
      title: "Navwalk Deal",
      amountCents: 500000,
      stage: "proposal",
    }),
  );
  const task = await data(
    await api(owner, "POST", "/tasks", org, {
      title: "Navwalk Task",
      customerId: customer.id,
      opportunityId: deal.id,
      dueDate: "2020-01-01",
    }),
  );
  const quote = await data(
    await api(owner, "POST", "/quotes", org, {
      customerId: customer.id,
      opportunityId: deal.id,
      title: "Navwalk Quote",
      taxRateBps: 0,
      discountCents: 0,
      items: [{ description: "Work", quantity: 1, unitPriceCents: 10000 }],
    }),
  );
  Object.assign(ids, { customer: customer.id, deal: deal.id, task: task.id, quote: quote.id });
});
test.afterAll(cleanUp);

const settle = (page: Page) => page.waitForLoadState("domcontentloaded");

test("every related link works and each list is left and returned to with its filters", async ({
  page,
  context,
}) => {
  await signIn(context, owner);

  // customers list with a search, to the detail page, and back through the breadcrumb with the search kept
  await page.goto("/app/customers?q=navwalk");
  await settle(page);
  await page.getByRole("link", { name: "Navwalk Customer" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/customers/${ids.customer}$`));
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail.getByText("Navwalk Customer")).toHaveAttribute("aria-current", "page");
  await expect(trail.getByRole("link", { name: "Customers" })).toHaveAttribute(
    "href",
    "/app/customers?q=navwalk",
  );
  expect(await axeViolations(page)).toEqual([]);

  // customer -> its opportunities in the list, narrowed, and the scope note
  await page.getByRole("tab", { name: /Opportunities/ }).click();
  await page.getByRole("link", { name: "Open these in the Opportunities list" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/app/opportunities\\?view=list&customerId=${ids.customer}`),
  );
  await expect(page.getByText("Showing only deals for one customer.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Navwalk Deal" })).toBeVisible();

  // deal detail: breadcrumb, customer link, then its tasks and its quotes
  await page.getByRole("link", { name: "Navwalk Deal" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/opportunities/${ids.deal}$`));
  const dealTrail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(dealTrail.getByRole("link", { name: "Opportunities" })).toHaveAttribute(
    "href",
    new RegExp(`customerId=${ids.customer}`),
  );
  const related = page.getByRole("navigation", { name: "Related records" });
  await expect(related.getByRole("link", { name: "Customer: Navwalk Customer" })).toHaveAttribute(
    "href",
    `/app/customers/${ids.customer}`,
  );
  expect(await axeViolations(page)).toEqual([]);
  await related.getByRole("link", { name: "Tasks for this deal" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/tasks\\?opportunityId=${ids.deal}`));
  await expect(page.getByText("Showing only tasks linked to one deal.")).toBeVisible();
  const taskRow = page.getByRole("row", { name: /Navwalk Task/ });
  await expect(taskRow).toBeVisible();
  // the task links back to its customer and its deal
  await expect(taskRow.getByRole("link", { name: "Navwalk Customer" })).toHaveAttribute(
    "href",
    `/app/customers/${ids.customer}`,
  );
  await expect(taskRow.getByRole("link", { name: "Navwalk Deal" })).toHaveAttribute(
    "href",
    `/app/opportunities/${ids.deal}`,
  );
  await page.goBack();
  await page
    .getByRole("navigation", { name: "Related records" })
    .getByRole("link", { name: "Quotes for this deal" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes\\?opportunityId=${ids.deal}`));
  await expect(page.getByText("Showing only quotes for one deal.")).toBeVisible();

  // quote detail: customer and deal links, breadcrumb back to the narrowed list
  await page
    .getByRole("row", { name: /Navwalk Quote/ })
    .getByRole("link")
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${ids.quote}$`));
  await expect(page.getByRole("link", { name: "Navwalk Deal" })).toHaveAttribute(
    "href",
    `/app/opportunities/${ids.deal}`,
  );
  await expect(page.getByRole("link", { name: "Navwalk Customer" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("link", { name: "Quotes" })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes\\?opportunityId=${ids.deal}`));

  // the activity feed links to the record
  await page.goto("/app/activity");
  await settle(page);
  await expect(page.getByRole("link", { name: /Navwalk Customer/ }).first()).toBeVisible();
});

test("the dashboard's cards and stage segments lead to the matching filtered lists", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app");
  await settle(page);
  await page.getByRole("link", { name: /^Overdue tasks/ }).click();
  await expect(page).toHaveURL(/\/app\/tasks\?overdue=true/);
  await expect(page.getByRole("row", { name: /Navwalk Task/ })).toBeVisible();

  await page.goto("/app");
  const chips = page.getByRole("navigation", { name: "Open a stage in the list" });
  await expect(chips).toBeVisible({ timeout: 20_000 });
  await chips.getByRole("link", { name: /^Proposal/ }).click();
  await expect(page).toHaveURL(/\/app\/opportunities\?view=list&stage=proposal/);
  await expect(page.getByRole("link", { name: "Navwalk Deal" })).toBeVisible();

  // a click on the drawn bar itself does the same
  await page.goto("/app");
  const bar = page.locator(".recharts-bar-rectangle").nth(2);
  await bar.waitFor({ timeout: 20_000 });
  await bar.click();
  await expect(page).toHaveURL(/\/app\/opportunities\?view=list&stage=proposal/);
});

test("Copy link copies the filtered URL, and opening it in another session of the same workspace reproduces the view", async ({
  page,
  context,
  browser,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(context, owner);
  await page.goto("/app/tasks?status=todo&sort=title&order=desc");
  await settle(page);
  await expect(page.getByRole("row", { name: /Navwalk Task/ })).toBeVisible();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/app\/tasks\?status=todo&sort=title&order=desc$/);
  expect(copied).not.toMatch(/@|token|cookie/i);

  const other = await browser.newContext();
  await signIn(other, owner);
  const second = await other.newPage();
  await second.goto(copied);
  await expect(second.getByRole("combobox", { name: /Status/ })).toHaveValue("todo");
  await expect(second.getByRole("row", { name: /Navwalk Task/ })).toBeVisible();
  await other.close();
});

test("an archived customer is marked wherever it is linked, and its page still opens", async ({
  page,
  context,
}) => {
  const customer = await data(
    await api(owner, "POST", "/customers", org, { displayName: "Soon Archived" }),
  );
  const deal = await data(
    await api(owner, "POST", "/opportunities", org, {
      customerId: customer.id,
      title: "Archived Customer Deal",
      amountCents: 1000,
    }),
  );
  expect((await api(owner, "DELETE", `/customers/${customer.id}`, org)).status).toBe(204);
  await signIn(context, owner);
  await page.goto(`/app/opportunities/${deal.id}`);
  await settle(page);
  await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Soon Archived" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/app/customers/${customer.id}$`));
  await expect(page.getByRole("heading", { name: /Soon Archived/ })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("a foreign or unknown id is a not-found page, not a leak", async ({ page, context }) => {
  await signIn(context, owner);
  for (const path of [
    "/app/customers/00000000-0000-4000-8000-0000000000ff",
    "/app/opportunities/00000000-0000-4000-8000-0000000000ff",
    "/app/quotes/00000000-0000-4000-8000-0000000000ff",
    "/app/customers/not-a-uuid",
  ]) {
    await page.goto(path);
    // the not-found page: the same words for a missing id and for another workspace's id
    await expect(page.getByRole("heading", { name: "Not found" }), path).toBeVisible();
  }
  // a hand-edited filter id is ignored, not an error
  const res = await page.goto("/app/tasks?customerId=not-a-uuid&opportunityId=%27%3B--");
  expect(res?.status()).toBe(200);
  await expect(page.getByText(/Showing only tasks/)).toHaveCount(0);
});
