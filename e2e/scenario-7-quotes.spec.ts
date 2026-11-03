import { readFileSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { extractPdfText } from "../src/lib/pdf/document";
import {
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  api,
  trackBrowserUser,
  type Person,
} from "./support/local";

/**
 * [SIT-267] PRD 11.4 scenario 7, the whole story in a real browser: create a quote with several items and check the displayed totals,
 * send it (the fields lock), create a revision, see that the original is unchanged, and download the PDF and read its content
 * (number, total, and the watermark in a demo only).
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

const pdfText = async (download: Download) =>
  extractPdfText(new Uint8Array(readFileSync(await download.path()))).join("\n");
async function downloadPdf(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  return download;
}
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

test("scenario 7: create, check totals, send, revise, original unchanged, download the PDF (real workspace)", async ({
  page,
  context,
}) => {
  const owner: Person = await makeUser("s7o");
  const org = await makeWorkspace(owner, "E2E Scenario 7 Co");
  const c = await api(owner, "POST", "/customers", org, { displayName: "Scenario Customer" });
  const customerId = ((await c.json()) as { data: { id: string } }).data.id;
  await signIn(context, owner);

  // 1. create a quote with several items; the totals shown are the arithmetic, then the server's
  await page.goto(`/app/quotes/new?customerId=${customerId}`);
  await page.waitForLoadState("domcontentloaded");
  await page.getByLabel(/^Title/).fill("Scenario seven job");
  await fillLine(page, 1, "Boiler, 120 kBTU", "1", "2,850.00");
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 2, "Labor, per hour", "14", "95.00");
  await page.getByRole("button", { name: "Add line" }).click();
  await fillLine(page, 3, "Permit fee", "1", "350.00");
  await page.getByLabel(/^Discount \(USD\)/).fill("200");
  await page.getByLabel(/^Tax rate/).fill("6");
  // 2850 + 1330 + 350 = 4530.00; less 200.00 = 4330.00; tax 6% = 259.80; total 4589.80
  const totals = page.getByRole("region", { name: "Totals" });
  await expect(totals.getByText("$4,530.00")).toBeVisible();
  await expect(totals.getByText("$4,589.80")).toBeVisible();
  await page.getByRole("button", { name: "Create quote" }).click();
  await page.waitForURL(/\/app\/quotes\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const originalUrl = page.url();
  const originalId = originalUrl.split("/").pop()!;
  const saved = (await (await api(owner, "GET", `/quotes/${originalId}`, org)).json()) as {
    data: {
      quoteNumber: string;
      totalCents: number;
      subtotalCents: number;
      taxCents: number;
      version: number;
    };
  };
  expect([saved.data.subtotalCents, saved.data.taxCents, saved.data.totalCents]).toEqual([
    453000, 25980, 458980,
  ]);

  // 2. send: the fields lock
  await page.getByRole("button", { name: "Send quote" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("so its amounts and lines can no longer change")).toBeVisible();
  // Next keeps the previous page mounted but hidden after a client-side redirect, so only visible inputs count
  await expect(page.getByLabel(/^Title/).locator("visible=true")).toHaveCount(0);
  await expect(page.getByLabel("Description, line 1").locator("visible=true")).toHaveCount(0);
  const sentView = (await (await api(owner, "GET", `/quotes/${originalId}`, org)).json()) as {
    data: Record<string, unknown>;
  };
  const edit = await api(owner, "PATCH", `/quotes/${originalId}`, org, {
    expectedVersion: sentView.data.version,
    title: "Tampered",
  });
  expect(edit.status).toBe(409); // and the API refuses it too

  // 3. create a revision: a new draft that points back
  await page.getByRole("button", { name: "Create revision" }).click();
  await page.waitForURL(
    (url) => url.pathname.startsWith("/app/quotes/") && !originalUrl.endsWith(url.pathname),
    { timeout: 30_000 },
  );
  await expect(page.getByRole("region", { name: "Revision history" })).toContainText(
    "Revises (earlier version)",
  );
  await expect(page.getByLabel(/^Title/).locator("visible=true")).toHaveCount(1); // the revision is an editable draft
  const revisionId = page.url().split("/").pop()!;
  expect(revisionId).not.toBe(originalId);

  // 4. the original is exactly as it was
  const after = (await (await api(owner, "GET", `/quotes/${originalId}`, org)).json()) as {
    data: Record<string, unknown> & { revisions: unknown[] };
  };
  const strip = (o: Record<string, unknown>) => {
    const copy = { ...o };
    delete copy.revisions;
    delete copy.statusHistory;
    return copy;
  };
  expect(strip(after.data)).toEqual(strip(sentView.data));
  expect(after.data.revisions).toHaveLength(1);
  await page.goto(`/app/quotes/${originalId}`);
  await expect(page.getByRole("heading", { name: "Scenario seven job" })).toBeVisible();
  await expect(page.getByText("$4,589.80").first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Revision history" })).toContainText(
    "Revised by (later version)",
  );

  // 5. the PDF: number, total, lines, and no watermark in a real workspace
  const text = await pdfText(await downloadPdf(page));
  for (const needle of [
    saved.data.quoteNumber,
    "Scenario seven job",
    "Scenario Customer",
    "Boiler, 120 kBTU",
    "$2,850.00",
    "$1,330.00",
    "$4,530.00",
    "-$200.00",
    "Tax (6%)",
    "$259.80",
    "$4,589.80",
    "Sent",
  ])
    expect(text, needle).toContain(needle);
  expect(text).not.toContain("Sample / fictional data");
});

test("scenario 7 in the demo: send is simulated, and the PDF carries the watermark", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await page.goto("/app/quotes");
  await page.waitForLoadState("domcontentloaded");
  // a seeded draft: send it and read what the dialog says
  await page.getByLabel("Status").selectOption("draft");
  await expect(page).toHaveURL(/status=draft/);
  await page
    .getByRole("link", { name: /^Q-\d{6}$/ })
    .first()
    .click();
  await expect(page.getByRole("button", { name: "Send quote" })).toBeVisible();
  await page.getByRole("button", { name: "Send quote" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("sending is simulated");
  await expect(dialog).toContainText("nothing is emailed");
  await dialog.getByRole("button", { name: "Send quote" }).click();
  await expect(page.getByText("so its amounts and lines can no longer change")).toBeVisible();

  const quoteNumber = (await page
    .locator("header p span.font-medium")
    .first()
    .textContent())!.trim();
  const download = await downloadPdf(page);
  expect(download.suggestedFilename()).toBe(`${quoteNumber}.pdf`);
  const pages = extractPdfText(new Uint8Array(readFileSync(await download.path())));
  for (const p of pages) expect(p).toContain("Sample / fictional data");
  expect(pages.join("\n")).toContain(quoteNumber);
  expect(pages.join("\n")).toContain("Sent");
  expect(pages.join("\n")).toMatch(/Total\n\$[\d,]+\.\d{2}/);
});
