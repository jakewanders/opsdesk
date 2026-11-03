import { expect, test } from "@playwright/test";
import { axeViolations } from "./support/axe";
import { addMember, cleanUp, makeUser, makeWorkspace, signIn, type Person } from "./support/local";

/** [SIT-232] The organization settings page in a real browser: an admin edits, a member only reads, axe is clean in both. */
let owner: Person, admin: Person, member: Person;
let org = "";

test.beforeAll(async () => {
  [owner, admin, member] = await Promise.all([makeUser("oso"), makeUser("osa"), makeUser("osm")]);
  org = await makeWorkspace(owner, "E2E Settings Co");
  addMember(org, admin, "admin");
  addMember(org, member, "member");
});
test.afterAll(cleanUp);

test("an admin renames the workspace and changes its time zone; both survive a reload", async ({
  page,
  context,
}) => {
  await signIn(context, admin);
  await page.goto("/app/settings/organization");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
  await expect(page.getByText("Your role in this workspace:")).toContainText("Admin");
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeDisabled();
  expect(await axeViolations(page)).toEqual([]);

  await page.getByLabel(/^Workspace name/).fill("E2E Settings Renamed");
  await page.getByLabel(/^Industry/).fill("Heating and cooling");
  await page.getByLabel(/^Time zone/).selectOption("America/Chicago");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled(); // saved: the form is clean again

  await page.reload();
  await expect(page.getByLabel(/^Workspace name/)).toHaveValue("E2E Settings Renamed");
  await expect(page.getByLabel(/^Industry/)).toHaveValue("Heating and cooling");
  await expect(page.getByLabel(/^Time zone/)).toHaveValue("America/Chicago");

  // a name that is too short is explained next to the field and nothing is sent
  await page.getByLabel(/^Workspace name/).fill("A");
  await save.click();
  await expect(page.locator("#org-name-error")).toContainText("Use between 2 and 80 characters.");
  await expect(save).toHaveCSS("opacity", "1"); // wait out the button's colour transition before measuring contrast
  expect(await axeViolations(page)).toEqual([]);
});

test("a member sees the values as text, with the reason, and no way to save", async ({
  page,
  context,
}) => {
  await signIn(context, member);
  await page.goto("/app/settings/organization");
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("heading", { name: "Organization settings" })).toBeVisible();
  await expect(page.getByText("Only owners and admins can change these settings.")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});
