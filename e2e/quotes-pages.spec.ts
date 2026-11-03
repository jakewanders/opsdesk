import { expect, test } from "@playwright/test";
import { axeViolations } from "./support/axe";
import {
  addMember,
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  type Person,
} from "./support/local";

/** [SIT-246] PRD 11.4 scenario 7, read side: the quote list, the detail page with status changes, history and the revision chain, the customer's Quotes tab. */
let owner: Person, viewer: Person;
let org = "";
let customerId = "";
const ids: Record<string, string> = {};

async function makeQuote(title: string, over: Record<string, unknown> = {}) {
  const res = await api(owner, "POST", "/quotes", org, {
    customerId,
    title,
    taxRateBps: 825,
    discountCents: 0,
    items: [{ description: "Service call", quantity: 2, unitPriceCents: 12500 }],
    ...over,
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string; quoteNumber: string } }).data;
}
const transition = (id: string, to: string) =>
  api(owner, "POST", `/quotes/${id}/transition`, org, { to });

test.beforeAll(async () => {
  [owner, viewer] = await Promise.all([makeUser("qpo"), makeUser("qpv")]);
  org = await makeWorkspace(owner, "E2E Quote Pages Co");
  addMember(org, viewer, "viewer");
  const c = await api(owner, "POST", "/customers", org, { displayName: "Pages Customer" });
  customerId = ((await c.json()) as { data: { id: string } }).data.id;
  const draft = await makeQuote("Draft job");
  const sent = await makeQuote("Sent job");
  await transition(sent.id, "sent");
  const toRevise = await makeQuote("Revision job");
  await transition(toRevise.id, "sent");
  const revision = (
    (await (await api(owner, "POST", `/quotes/${toRevise.id}/revise`, org)).json()) as {
      data: { id: string };
    }
  ).data;
  Object.assign(ids, {
    draft: draft.id,
    sent: sent.id,
    original: toRevise.id,
    revision: revision.id,
  });
});
test.afterAll(cleanUp);

test("the list shows every quote with status and total, filters by status and search, and opens a quote", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app/quotes");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Quotes", exact: true })).toBeVisible();
  const table = page.getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(5); // header + 4 quotes
  await expect(table.getByText("$270.63").first()).toBeVisible(); // 250.00 + 8.25% tax
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel("Status").selectOption("sent");
  await expect(page).toHaveURL(/status=sent/);
  await expect(table.getByRole("row")).toHaveCount(3); // header + the two sent quotes
  await expect(table.getByText("Draft job")).toHaveCount(0);

  await page.getByLabel("Status").selectOption({ label: "All statuses" });
  await expect(page).not.toHaveURL(/status=/); // let the URL settle before typing
  await page.getByLabel("Search").fill("Draft job");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(table.getByRole("row")).toHaveCount(2);
  await page.getByRole("link", { name: /^Q-\d{6}$/ }).click();
  await expect(page.getByRole("heading", { name: "Draft job" })).toBeVisible();
});

test("a draft is sent from its page: the status, the locked fields and the history all follow", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/${ids.draft}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Draft job" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create quote" })).toHaveCount(0);
  await expect(page.getByLabel(/^Title/)).toBeVisible(); // still the editor
  const historyItems = page.getByRole("list", { name: "Quote history" }).getByRole("listitem");
  const beforeSend = await historyItems.count();
  expect(beforeSend).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Send quote" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("no longer be editable");
  await dialog.getByRole("button", { name: "Send quote" }).click();
  await expect(
    page.getByText("This quote is sent, so its amounts and lines can no longer change."),
  ).toBeVisible();
  await expect(page.getByLabel(/^Title/)).toHaveCount(0); // no inputs any more
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
  const history = page.getByRole("list", { name: "Quote history" });
  await expect.poll(() => history.getByRole("listitem").count()).toBeGreaterThan(beforeSend); // the send is in the history
  await expect(history).toContainText("status");
  const afterSend = await history.getByRole("listitem").count();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve quote" }).click();
  await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect
    .poll(() => page.getByRole("list", { name: "Quote history" }).getByRole("listitem").count())
    .toBeGreaterThan(afterSend);
  await expect(page.getByText("Approved").first()).toBeVisible();
});

test("the revision chain links both ways", async ({ page, context }) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/${ids.original}`);
  await page.waitForLoadState("domcontentloaded");
  const chain = page.getByRole("region", { name: "Revision history" });
  await expect(chain).toContainText("Revised by (later version)");
  await chain.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${ids.revision}$`));
  const back = page.getByRole("region", { name: "Revision history" });
  await expect(back).toContainText("Revises (earlier version)");
  await back.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes/${ids.original}$`));
});

test("the customer's Quotes tab lists their quotes and links to the filtered list", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto(`/app/customers/${customerId}`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("tab", { name: /^Quotes \(/ }).click();
  await expect(page.getByRole("link", { name: /Sent job/ })).toBeVisible();
  await page.getByRole("link", { name: /Open in the quote list|See all/ }).click();
  await expect(page).toHaveURL(new RegExp(`/app/quotes\\?customerId=${customerId}`));
  await expect(page.getByRole("table").getByRole("row").nth(1)).toBeVisible();
});

test("a viewer reads the list and a quote, with no way to create or change anything", async ({
  page,
  context,
}) => {
  await signIn(context, viewer);
  await page.goto("/app/quotes");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("link", { name: "New quote" })).toHaveCount(0);
  await page.goto(`/app/quotes/${ids.sent}`);
  await expect(page.getByRole("heading", { name: "Sent job" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Approve|Reject|Mark expired|Send quote|Create revision/ }),
  ).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("at 375 px the list and a quote fit without sideways page scrolling and pass axe", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(context, owner);
  for (const path of ["/app/quotes", `/app/quotes/${ids.sent}`]) {
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, path).toBeLessThanOrEqual(0);
    expect(await axeViolations(page), path).toEqual([]);
  }
});
