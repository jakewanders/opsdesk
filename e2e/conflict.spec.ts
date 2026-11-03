import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./support/axe";
import { api, cleanUp, makeUser, makeWorkspace, signIn, type Person } from "./support/local";

/**
 * [SIT-271] PRD 7.5: two sessions of the same person edit one record. The second save shows the shared conflict dialog (focus inside,
 * announced, axe clean), names the fields that changed on each side, never overwrites, and no data is lost whichever way it is resolved.
 */
let owner: Person;
let org = "";
let customerId = "";
const data = async (res: Response) => ((await res.json()) as { data: Record<string, string> }).data;
const read = async () => data(await api(owner, "GET", `/customers/${customerId}`, org));
const reset = async (body: Record<string, unknown>) => {
  const cur = await read();
  const res = await api(owner, "PATCH", `/customers/${customerId}`, org, {
    ...body,
    expectedUpdatedAt: cur.updatedAt,
  });
  expect(res.status).toBe(200);
};

test.beforeAll(async () => {
  owner = await makeUser("cfo");
  org = await makeWorkspace(owner, "E2E Conflict Co");
  customerId = (
    await data(
      await api(owner, "POST", "/customers", org, { displayName: "Conflict Customer", phone: "" }),
    )
  ).id;
});
test.afterAll(cleanUp);

async function openEdit(page: Page) {
  await page.goto(`/app/customers/${customerId}/edit`);
  await expect(page.getByLabel(/^Display name/)).toHaveValue(/Conflict|Edited|Theirs|Mine/);
}

test("different fields: the second save shows the dialog, 'Apply my changes on top' keeps both, and nothing is lost", async ({
  browser,
}) => {
  await reset({ displayName: "Conflict Customer", phone: "" });
  const a = await browser.newContext();
  const b = await browser.newContext();
  await signIn(a, owner);
  await signIn(b, owner);
  const pa = await a.newPage();
  const pb = await b.newPage();
  await openEdit(pa);
  await openEdit(pb);

  // B saves a phone number first
  await pb.getByLabel(/^Phone/).fill("(202) 555-0101");
  await pb.getByRole("button", { name: "Save changes" }).click();
  await pb.waitForURL(new RegExp(`/app/customers/${customerId}$`));

  // A renames and saves: conflict
  await pa.getByLabel(/^Display name/).fill("Conflict Customer Renamed");
  await pa.getByRole("button", { name: "Save changes" }).click();
  const dialog = pa.getByRole("alertdialog", { name: "Someone else changed this customer" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Changed by them: Phone.");
  await expect(dialog).toContainText("Changed by you: Display name.");
  // focus is inside the dialog, and it passes axe
  expect(
    await pa.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]'))),
  ).toBe(true);
  await expect(dialog).toHaveCSS("opacity", "1"); // let the dialog finish fading in before measuring contrast
  await expect(dialog.getByRole("button", { name: "Reload latest" })).toBeEnabled();
  expect(await axeViolations(pa)).toEqual([]);
  // nothing was overwritten
  expect((await read()).displayName).toBe("Conflict Customer");
  expect((await read()).phone).toBe("(202) 555-0101");

  await dialog.getByRole("button", { name: "Apply my changes on top" }).click();
  await expect(pa.getByLabel(/^Phone/)).toHaveValue("(202) 555-0101");
  await expect(pa.getByLabel(/^Display name/)).toHaveValue("Conflict Customer Renamed");
  await pa.getByRole("button", { name: "Save changes" }).click();
  await pa.waitForURL(new RegExp(`/app/customers/${customerId}$`));
  const final = await read();
  expect(final.displayName).toBe("Conflict Customer Renamed");
  expect(final.phone).toBe("(202) 555-0101");
  await a.close();
  await b.close();
});

test("the same field: no 'apply on top'; Keep editing keeps the typing and conflicts again; Reload latest shows theirs, losing nothing on the server", async ({
  browser,
}) => {
  await reset({ displayName: "Conflict Customer Base" });
  const a = await browser.newContext();
  const b = await browser.newContext();
  await signIn(a, owner);
  await signIn(b, owner);
  const pa = await a.newPage();
  const pb = await b.newPage();
  await a.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openEdit(pa);
  await openEdit(pb);

  await pb.getByLabel(/^Display name/).fill("Theirs Edited");
  await pb.getByRole("button", { name: "Save changes" }).click();
  await pb.waitForURL(new RegExp(`/app/customers/${customerId}$`));

  await pa.getByLabel(/^Display name/).fill("Mine Edited");
  await pa.getByRole("button", { name: "Save changes" }).click();
  const dialog = pa.getByRole("alertdialog", { name: "Someone else changed this customer" });
  await expect(dialog).toContainText("You both changed Display name");
  await expect(dialog.getByRole("button", { name: "Apply my changes on top" })).toHaveCount(0);

  // copy mine aside
  await dialog.getByRole("button", { name: "Copy my changes" }).click();
  expect(await pa.evaluate(() => navigator.clipboard.readText())).toBe("Display name: Mine Edited");

  // keep editing: the typing is still there, the server still has theirs, and saving again conflicts again
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(pa.getByLabel(/^Display name/)).toHaveValue("Mine Edited");
  expect((await read()).displayName).toBe("Theirs Edited");
  await pa.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeVisible();
  expect((await read()).displayName).toBe("Theirs Edited");

  await dialog.getByRole("button", { name: "Reload latest" }).click();
  await expect(pa.getByLabel(/^Display name/)).toHaveValue("Theirs Edited");
  await a.close();
  await b.close();
});

test("a task edited in two sessions, and the workspace settings, use the same dialog", async ({
  browser,
}) => {
  const task = await data(
    await api(owner, "POST", "/tasks", org, { title: "Conflict Task", dueDate: "2030-01-01" }),
  );
  const a = await browser.newContext();
  await signIn(a, owner);
  const page = await a.newPage();
  await page.goto("/app/tasks");
  await page.getByRole("button", { name: /^Conflict Task\s*\(edit\)$/ }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel(/^Title/).fill("Conflict Task Mine");
  // someone else changes the task's priority meanwhile
  const cur = await data(await api(owner, "GET", `/tasks/${task.id}`, org));
  expect(
    (
      await api(owner, "PATCH", `/tasks/${task.id}`, org, {
        priority: "urgent",
        expectedUpdatedAt: cur.updatedAt,
      })
    ).status,
  ).toBe(200);
  await drawer.getByRole("button", { name: "Save changes" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Someone else changed this task" });
  await expect(dialog).toContainText("Changed by them: Priority.");
  await expect(dialog).toContainText("Changed by you: Title.");
  await expect(dialog).toHaveCSS("opacity", "1");
  await expect(dialog.getByRole("button", { name: "Reload latest" })).toBeEnabled();
  expect(await axeViolations(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Apply my changes on top" }).click();
  await expect(drawer.getByLabel(/^Priority/)).toHaveValue("urgent");
  await drawer.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Task saved")).toBeVisible();
  const finalTask = await data(await api(owner, "GET", `/tasks/${task.id}`, org));
  expect(finalTask.title).toBe("Conflict Task Mine");
  expect(finalTask.priority).toBe("urgent");

  // workspace settings
  await page.goto("/app/settings/organization");
  await page.getByLabel(/^Industry/).fill("Conflict industry");
  const orgNow = await data(await api(owner, "GET", `/organizations/${org}`, org));
  expect(
    (
      await api(owner, "PATCH", `/organizations/${org}`, org, {
        name: "E2E Conflict Co Renamed",
        industry: orgNow.industry ?? null,
        timezone: orgNow.timezone,
        expectedUpdatedAt: orgNow.updatedAt,
      })
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "Save changes" }).click();
  const orgDialog = page.getByRole("alertdialog", { name: /Someone else changed this/ });
  await expect(orgDialog).toContainText("Changed by them: Workspace name.");
  await orgDialog.getByRole("button", { name: "Apply my changes on top" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  const finalOrg = await data(await api(owner, "GET", `/organizations/${org}`, org));
  expect(finalOrg.name).toBe("E2E Conflict Co Renamed");
  expect(finalOrg.industry).toBe("Conflict industry");
  await a.close();
});
