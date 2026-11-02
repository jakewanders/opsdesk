import { expect, test } from "@playwright/test";
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
import { psql } from "../src/test/local-supabase";

/** [SIT-233] The Members page in a real browser: invite and copy the one-time link, change a role, remove, last-owner rule. */
let owner: Person, sam: Person, viewer: Person;
let org = "";
const name = (p: Person, display: string) =>
  psql(`update public.profiles set display_name = '${display}' where id = '${p.id}'`);

test.beforeAll(async () => {
  [owner, sam, viewer] = await Promise.all([makeUser("mo"), makeUser("ms"), makeUser("mv")]);
  org = await makeWorkspace(owner, "E2E Members Co");
  addMember(org, sam, "member");
  addMember(org, viewer, "viewer");
  name(owner, "Olive Owner");
  name(sam, "Sam Member");
  name(viewer, "Vic Viewer");
});
test.afterAll(cleanUp);

test("an owner invites with a one-time link, changes a role and removes a member, by keyboard and mouse", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://localhost:3111",
  });
  await signIn(context, owner);
  await page.goto("/app/settings/members");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  const people = page.getByRole("table", { name: "Members of this workspace" });
  await expect(people.getByRole("row", { name: /Sam Member/ })).toContainText("Member");
  expect(await axeViolations(page)).toEqual([]);

  // the only owner: no controls, and the reason is in words
  const ownerRow = people.getByRole("row", { name: /Olive Owner/ });
  await expect(ownerRow.getByRole("button")).toHaveCount(0);
  await expect(ownerRow).toContainText("at least one owner");

  // invite by keyboard
  const invite = page.getByRole("button", { name: "Invite someone" }).first();
  await invite.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Email address/)).toBeFocused();
  await page.keyboard.type("newhire@example.test");
  await dialog.getByLabel("Role").selectOption("viewer");
  await page.keyboard.press("Enter");
  const ready = page.getByRole("dialog", { name: "Invitation ready" });
  await expect(ready).toContainText("This link will not be shown again");
  const link = await ready.getByLabel("Invite link").inputValue();
  expect(link).toMatch(/^http:\/\/localhost:3111\/invite#token=[0-9a-f]{64}$/);
  await page.waitForTimeout(500); // let the dialog finish fading in: axe reads the colors it can see
  expect(await axeViolations(page)).toEqual([]);
  await ready.getByRole("button", { name: "Copy invite link" }).click();
  await expect(ready.getByText("Link copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.keyboard.press("Escape");
  await expect(ready).toHaveCount(0);

  // the invitation is listed (expiry, revoke) and the link is not shown again
  const pending = page.getByRole("table", { name: "Invitations that have not been used" });
  await expect(pending.getByRole("row", { name: /newhire@example.test/ })).toContainText("Viewer");
  await expect(page.getByText(link)).toHaveCount(0);
  await expect(page.locator(`input[value*="invite#token"]`)).toHaveCount(0);

  // role change
  await people.getByRole("button", { name: /Change role\s*for Sam Member/ }).click();
  const roleDialog = page.getByRole("dialog", { name: /Change role for Sam Member/ });
  await roleDialog.getByLabel("New role").selectOption("admin");
  await page.waitForTimeout(500);
  expect(await axeViolations(page)).toEqual([]);
  await roleDialog.getByRole("button", { name: "Change role" }).click();
  await expect(people.getByRole("row", { name: /Sam Member/ })).toContainText("Admin");

  // removal asks first
  await people.getByRole("button", { name: /Remove\s*Sam Member/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove Sam Member?" });
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirm.getByRole("button", { name: "Remove member" }).click();
  await expect(people.getByRole("row", { name: /Sam Member/ })).toHaveCount(0);

  // revoke the pending invitation
  await pending.getByRole("button", { name: /Revoke\s*invitation for newhire/ }).click();
  await page.getByRole("button", { name: "Revoke invitation", exact: true }).click();
  await expect(page.getByText("No pending invitations")).toBeVisible();
});

test("the API refuses to demote the last owner even if the page is stale", async () => {
  const res = await api(owner, "PATCH", `/members/${owner.id}`, org, { role: "admin" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("LAST_OWNER");
});

test("a viewer sees the list and no controls", async ({ page, context }) => {
  await signIn(context, viewer);
  await page.goto("/app/settings/members");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("row", { name: /Olive Owner/ })).toContainText("Owner");
  await expect(page.getByRole("button", { name: /Invite someone|Change role|Remove/ })).toHaveCount(
    0,
  );
  await expect(page.getByText("Only owners and admins can change this list.")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
});

test("a demo guest sees why invitations are unavailable, with no controls", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  await trackBrowserUser(context);
  await page.goto("/app/settings/members");
  await expect(page.getByText(/Invitations are unavailable in the demo/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite someone/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
});
