import { expect, test, type Page } from "@playwright/test";
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

/** [SIT-263] PRD 11.4 scenario 7: the quote editor in a real browser: preview, save, keyboard reorder, sent quotes locked, revision. */
let owner: Person, viewer: Person;
let org = "";
let customerId = "";

test.beforeAll(async () => {
  [owner, viewer] = await Promise.all([makeUser("qeo"), makeUser("qev")]);
  org = await makeWorkspace(owner, "E2E Quote Editor Co");
  addMember(org, viewer, "viewer");
  const c = await api(owner, "POST", "/customers", org, { displayName: "Editor Customer" });
  customerId = ((await c.json()) as { data: { id: string } }).data.id;
});
test.afterAll(cleanUp);

const totals = (page: Page) => page.getByRole("region", { name: "Totals" });
async function fillLine(
  page: Page,
  n: number,
  description: string,
  quantity: string,
  price: string,
) {
  await page.getByLabel(`Description, line ${n}`).fill(description);
  await page.getByLabel(`Quantity, line ${n}`).fill(quantity);
  await page.getByLabel(`Unit price in dollars, line ${n}`).fill(price);
}
const descriptions = (page: Page) =>
  page
    .getByLabel(/^Description, line/)
    .locator("visible=true")
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test("an owner builds a quote: the preview matches what the server saves, lines reorder by keyboard and the order persists", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/new?customerId=${customerId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "New quote" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: /Customer/ })).toHaveValue("Editor Customer");
  await expect(totals(page).getByText("Preview")).toBeVisible();

  await page.getByLabel(/^Title/).fill("Rooftop unit replacement");
  await fillLine(page, 1, "Rooftop unit, 10 ton", "1", "8,450.00");
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 2, "Crane rental, per hour", "3", "325.50");
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 3, "Disposal of old unit", "1", "0.25");
  await page.getByLabel(/^Discount \(USD\)/).fill("100");
  await page.getByLabel(/^Tax rate/).fill("8.25");

  // 8450.00 + 976.50 + 0.25 = 9426.75; less 100.00 = 9326.75; tax 8.25% = 769.46 (76946.1875 cents, rounded); total 10,096.21
  await expect(totals(page).getByText("$9,426.75")).toBeVisible();
  await expect(totals(page).getByText("$10,096.21")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/app\/quotes\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = page.url().split("/").pop()!;

  // the server's saved totals are the preview's
  const saved = (await (await api(owner, "GET", `/quotes/${id}`, org)).json()) as {
    data: {
      quoteNumber: string;
      subtotalCents: number;
      taxCents: number;
      totalCents: number;
      items: Array<{ description: string; position: number }>;
    };
  };
  expect(saved.data.quoteNumber).toMatch(/^Q-\d{6}$/);
  expect([saved.data.subtotalCents, saved.data.taxCents, saved.data.totalCents]).toEqual([
    942675, 76946, 1009621,
  ]);
  await expect(totals(page).getByText(usd(saved.data.totalCents))).toBeVisible();

  // reorder by keyboard: line 3 up (Enter), then line 1 down (Space)
  await page.getByRole("button", { name: "Move line 3 up" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Line moved to position 2 of 3.")).toBeVisible();
  await page.getByRole("button", { name: "Move line 1 down" }).focus();
  await page.keyboard.press("Space");
  expect(await descriptions(page)).toEqual([
    "Disposal of old unit",
    "Rooftop unit, 10 ton",
    "Crane rental, per hour",
  ]);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(totals(page).getByText("Saved", { exact: true })).toBeVisible();

  // the saved positions are that order, and survive a reload
  const after = (await (await api(owner, "GET", `/quotes/${id}`, org)).json()) as {
    data: { version: number; items: Array<{ description: string; position: number }> };
  };
  expect(after.data.items.map((i) => `${i.position}:${i.description}`)).toEqual([
    "1:Disposal of old unit",
    "2:Rooftop unit, 10 ton",
    "3:Crane rental, per hour",
  ]);
  expect(after.data.version).toBe(2);
  await page.reload();
  await expect
    .poll(() => descriptions(page))
    .toEqual(["Disposal of old unit", "Rooftop unit, 10 ton", "Crane rental, per hour"]);
});

test("a half-cent of tax rounds up, in the preview and on the server", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/new?customerId=${customerId}`);
  await page.getByLabel(/^Title/).fill("Half-up check");
  await fillLine(page, 1, "Tiny item", "1", "0.25");
  await page.getByLabel(/^Tax rate/).fill("10");
  await expect(totals(page).getByText("$0.28")).toBeVisible(); // 2.5 cents of tax goes up to 3
  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/app\/quotes\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = page.url().split("/").pop()!;
  const q = (await (await api(owner, "GET", `/quotes/${id}`, org)).json()) as {
    data: { taxCents: number; totalCents: number };
  };
  expect([q.data.taxCents, q.data.totalCents]).toEqual([3, 28]);
});

test("a line can be dragged by its grip, and the mouse drag persists like the buttons", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/new?customerId=${customerId}`);
  await page.getByLabel(/^Title/).fill("Drag check");
  await fillLine(page, 1, "First", "1", "1.00");
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 2, "Second", "1", "2.00");
  const grip = page.getByRole("button", { name: "Drag line 2 to reorder" });
  const target = page.getByTestId("quote-line-1");
  const g = (await grip.boundingBox())!;
  const t = (await target.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 10, { steps: 4 });
  await page.mouse.move(t.x + 20, t.y + 5, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => descriptions(page)).toEqual(["Second", "First"]);
});

test("leaving with unsaved changes asks first", async ({ page, context }) => {
  await signIn(context, owner);
  await page.goto(`/app/quotes/new?customerId=${customerId}`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel(/^Title/).fill("Unsaved");
  await page.getByRole("link", { name: "Customers" }).first().click();
  const dialog = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/app\/quotes\/new/);
});

test("a sent quote cannot be edited in the UI or the API; a revision starts a new draft and leaves it untouched", async ({
  page,
  context,
}) => {
  const made = (await (
    await api(owner, "POST", "/quotes", org, {
      customerId,
      title: "To send",
      taxRateBps: 825,
      discountCents: 0,
      items: [{ description: "Service call", quantity: 2, unitPriceCents: 12500 }],
    })
  ).json()) as { data: { id: string; quoteNumber: string; version: number } };
  const sent = (await (
    await api(owner, "POST", `/quotes/${made.data.id}/transition`, org, { to: "sent" })
  ).json()) as { data: { version: number } };
  await signIn(context, owner);
  await page.goto(`/app/quotes/${made.data.id}`);
  await expect(page.getByRole("heading", { name: "To send" })).toBeVisible();
  await expect(page.getByRole("note")).toContainText("This quote is sent");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Save/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);

  const edit = await api(owner, "PATCH", `/quotes/${made.data.id}`, org, {
    expectedVersion: sent.data.version,
    title: "Sneaky",
  });
  expect(edit.status).toBe(409);
  expect(((await edit.json()) as { error: { code: string } }).error.code).toBe("QUOTE_LOCKED");

  const before = JSON.stringify(
    (await (await api(owner, "GET", `/quotes/${made.data.id}`, org)).json()) as object,
  );
  await page.getByRole("button", { name: "Create revision" }).click();
  await page.waitForURL(
    (u) => /\/app\/quotes\/[0-9a-f-]{36}$/.test(u.pathname) && !u.pathname.endsWith(made.data.id),
    { timeout: 30_000 },
  );
  await expect(page.getByRole("button", { name: "Save draft" })).toBeVisible();
  expect(await descriptions(page)).toEqual(["Service call"]);
  const originalAfter = JSON.parse(
    JSON.stringify(
      (await (await api(owner, "GET", `/quotes/${made.data.id}`, org)).json()) as object,
    ),
  );
  const originalBefore = JSON.parse(before);
  delete originalAfter.data.revisions;
  delete originalBefore.data.revisions;
  expect(originalAfter).toEqual(originalBefore);
});

test("a viewer sees quotes read-only and cannot start one", async ({ page, context }) => {
  const made = (await (
    await api(owner, "POST", "/quotes", org, {
      customerId,
      title: "Viewer can read",
      items: [{ description: "Item", quantity: 1, unitPriceCents: 1000 }],
    })
  ).json()) as { data: { id: string } };
  await signIn(context, viewer);
  await page.goto(`/app/quotes/${made.data.id}`);
  await expect(page.getByText(/view this draft but not edit it/)).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.goto("/app/quotes/new");
  await expect(page.getByText("You can view quotes but not create them")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
