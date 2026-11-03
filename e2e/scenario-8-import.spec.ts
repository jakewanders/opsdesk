import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./support/axe";
import {
  addMember,
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  trackBrowserUser,
  type Person,
} from "./support/local";

/** [SIT-248] PRD 11.4 scenario 8: import customers from a CSV in a real browser: upload, preview with exact errors, import only the valid rows, repeat safely. */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

const CSV = [
  "display_name,email,company,favorite_color",
  "Ada Lovelace,ada@import8.test,Analytical Engines,blue", // 2 ok
  ",nobody@import8.test,No Name Co,red", // 3 no name
  "Grace Hopper,grace@import8.test,Compilers Inc,green", // 4 ok
  "Alan Turing,not-an-email,Bletchley,grey", // 5 bad email
  "Grace Again,GRACE@import8.test,Compilers Inc,pink", // 6 repeats row 4's email
  "Katherine Johnson,katherine@import8.test,NASA,black", // 7 ok
].join("\n");
const upload = (page: Page, text: string, name = "customers.csv") =>
  page
    .getByLabel("CSV file", { exact: true })
    .setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
const customerCount = async (owner: Person, org: string, q: string) =>
  (
    (await (await api(owner, "GET", `/customers?q=${q}&limit=100`, org)).json()) as {
      data: unknown[];
    }
  ).data.length;

test("scenario 8: preview shows exact errors, import adds only the valid rows, and repeating the upload adds nothing", async ({
  page,
  context,
}) => {
  const owner = await makeUser("s8o");
  const org = await makeWorkspace(owner, "E2E Scenario 8 Co");
  await signIn(context, owner);

  await page.goto("/app/customers");
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("link", { name: "Import CSV" }).click();
  await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeFocused();
  expect(await axeViolations(page)).toEqual([]);

  // step 1 to 2
  await upload(page, CSV);
  await expect(page.getByText(/customers\.csv/)).toBeVisible();
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByRole("heading", { name: /^Review/ })).toBeFocused();
  const stats = page.getByText("Rows in the file").locator("xpath=ancestor::dl");
  await expect(stats).toContainText("Rows in the file6");
  await expect(stats).toContainText("Will be imported3"); // 4 valid, one of them repeats an email
  await expect(page.getByText(/Ignored \(not customer fields\): favorite_color/)).toBeVisible();
  const errors = page.getByRole("table", { name: /cannot be imported/ });
  await expect(errors.getByRole("row")).toHaveCount(3); // header + rows 3 and 5
  await expect(errors).toContainText("Enter a name.");
  await expect(errors).toContainText("Enter a valid email address.");
  await expect(page.getByRole("table", { name: /already in the workspace/ })).toContainText(
    "also on row 4",
  );
  await expect(page.getByText(/will be imported\./)).toContainText("3 customers will be imported");
  await expect(page.getByText(/will be skipped/)).toContainText(
    "3 rows will be skipped: 2 with errors, 1 with a repeated email",
  );
  expect(await axeViolations(page)).toEqual([]);

  // the error report downloads
  const [report] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download error report" }).click(),
  ]);
  expect(report.suggestedFilename()).toMatch(/^import-errors-[0-9a-f]{8}\.csv$/);

  // step 3
  await page.getByRole("button", { name: "Import 3 customers" }).click();
  await expect(page.getByRole("heading", { name: "3 customers imported" })).toBeFocused();
  const done = page.getByText("Imported", { exact: true }).locator("xpath=ancestor::dl");
  await expect(done).toContainText("Imported3");
  await expect(done).toContainText("Skipped: repeated email1");
  await expect(done).toContainText("Skipped: errors2");
  await expect(page.locator("[data-sonner-toast]").first()).toHaveCSS("opacity", "1"); // let the toast finish fading in before measuring contrast
  expect(await axeViolations(page)).toEqual([]);
  expect(await customerCount(owner, org, "import8")).toBe(3); // only the valid rows

  // repeating the same upload adds nothing
  await page.getByRole("button", { name: "Import another file" }).click();
  await upload(page, CSV);
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByText(/already imported into this workspace/)).toBeVisible();
  await page.getByRole("button", { name: "Show what happened" }).click();
  await expect(page.getByRole("heading", { name: "This file was already imported" })).toBeVisible();
  expect(await customerCount(owner, org, "import8")).toBe(3);

  // the imported customers are in the list, newest first
  await page.getByRole("link", { name: "View imported customers" }).click();
  await expect(page.getByRole("link", { name: "Katherine Johnson" })).toBeVisible();
});

test("a viewer has no Import CSV button and the import page says why", async ({
  page,
  context,
}) => {
  const owner = await makeUser("s8w");
  const viewer = await makeUser("s8v");
  const org = await makeWorkspace(owner, "E2E Scenario 8 Roles Co");
  addMember(org, viewer, "viewer");

  await signIn(context, viewer);
  await page.goto("/app/customers");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("link", { name: "Import CSV" })).toHaveCount(0);
  await page.goto("/app/customers/import");
  await expect(
    page.getByRole("heading", { name: "You can view customers but not import them" }),
  ).toBeVisible();
});

test("the wrong kind of file is refused before upload, and the wizard fits a phone", async ({
  page,
  context,
}) => {
  const owner = await makeUser("s8p");
  await makeWorkspace(owner, "E2E Scenario 8 Phone Co");
  await signIn(context, owner);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app/customers/import");
  // the step heading takes focus when the page hydrates, so this also means "ready for input"
  await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeFocused();
  await page
    .getByLabel("CSV file", { exact: true })
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("x") });
  await expect(page.locator("#import-file-error")).toContainText("Choose a CSV file");
  await upload(page, CSV);
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByRole("heading", { name: /^Review/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await axeViolations(page)).toEqual([]);
});

test("in the demo a big file imports up to the limit and says so", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app/customers/import");
  await expect(page.getByRole("heading", { name: "Choose a CSV file" })).toBeFocused();
  const rows = Array.from(
    { length: 60 },
    (_, i) => `Demo Import ${i + 1},demo-import-${i + 1}@example.test`,
  );
  await upload(page, ["display_name,email", ...rows].join("\n"));
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByRole("heading", { name: /^Review/ })).toBeVisible();
  await expect(page.getByText(/holds at most 50 customers/)).toBeVisible();
  await page.getByRole("button", { name: /^Import \d+ customers$/ }).click();
  await expect(page.getByRole("heading", { name: /customers imported$/ })).toBeVisible();
  await expect(page.getByText(/reached its limit of 50 customers/)).toBeVisible();
  await expect(page.locator("[data-sonner-toast]").first()).toHaveCSS("opacity", "1"); // let the toast finish fading in
  expect(await axeViolations(page)).toEqual([]);
});
