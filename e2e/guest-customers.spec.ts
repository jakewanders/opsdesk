import { expect, test } from "@playwright/test";
import { cleanUp, trackBrowserUser } from "./support/local";

test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

/** [SIT-251] PRD 11.4 scenario 1, as a guest: landing → Try Live Demo → customers → create, edit, archive, restore, activity. */
test("a guest creates, edits, archives and restores a customer and sees every event", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });

  await page.goto("/app/customers");
  await expect(page.getByRole("heading", { name: "Customers", level: 1 })).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();

  const name = `E2E Plumbing ${Date.now()}`;
  await page
    .getByRole("link", { name: /Add customer/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: /Add customer/ })).toBeVisible();
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email").fill("e2e@example.com");
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();

  await page.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`^Edit ${name}`) })).toBeVisible();
  await page.getByLabel("Phone").fill("(202) 555-0100");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  await expect(page.getByText("(202) 555-0100")).toBeVisible();

  await page.getByRole("button", { name: "Archive" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Related records and history are kept");
  await dialog.getByRole("button", { name: "Archive customer" }).click();
  await expect(page.getByText("This customer is archived.")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("This customer is archived.")).toBeHidden();

  await page.getByRole("tab", { name: "Activity" }).click();
  const timeline = page.getByRole("list", { name: "Activity" });
  for (const action of ["Created", "Updated", "Archived", "Restored"]) {
    await expect(timeline).toContainText(action);
  }
});
