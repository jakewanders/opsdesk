import { expect, test } from "@playwright/test";
import { psql } from "../src/test/local-supabase";
import {
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  PASSWORD,
  signIn,
  type Person,
} from "./support/local";

/**
 * [SIT-265] PRD 11.4 scenario 6, whole: an owner invites someone from the Members page and copies the link; the invitee follows
 * it, CREATES an account through the sign-up form, confirms the email address, accepts, and sees the workspace; the owner changes
 * their role and removes them, and their access ends.
 *
 * The confirmation email is read from the local mail catcher (Inbucket/Mailpit, port 54324). Local Supabase redirects a confirmation link whose
 * `redirect_to` is not on its allowlist (the E2E server is on port 3111, the allowlist names 3000) to the site URL, but the
 * one-time `code` still arrives; the test hands that code to the app's own `/auth/callback`, which is the step the email link
 * performs in production.
 */
const INBUCKET = "http://127.0.0.1:54324";
let owner: Person;
let org = "";

test.beforeAll(async () => {
  owner = await makeUser("jo");
  org = await makeWorkspace(owner, "E2E Journey Co");
  psql(`update public.profiles set display_name = 'Olive Owner' where id = '${owner.id}'`);
});
test.afterAll(() => {
  psql(`delete from auth.users where email like 'journey-%@example.test'`);
  cleanUp();
});

async function confirmationCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = (await (
      await fetch(`${INBUCKET}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json()) as { messages?: Array<{ ID: string }> };
    const id = found.messages?.[0]?.ID;
    if (id) {
      const msg = (await (await fetch(`${INBUCKET}/api/v1/message/${id}`)).json()) as {
        Text?: string;
        HTML?: string;
      };
      const link = /https?:\/\/[^\s"'<>)]*\/auth\/v1\/verify\?[^\s"'<>)]*/.exec(
        `${msg.Text ?? ""} ${msg.HTML ?? ""}`,
      )?.[0];
      if (link) {
        const res = await fetch(link.replace(/&amp;/g, "&"), { redirect: "manual" });
        const location = res.headers.get("location") ?? "";
        const code = new URL(location, "http://x").searchParams.get("code");
        if (code) return code;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no confirmation code arrived for ${email}`);
}

test("invite, copy link, sign up, confirm, accept, see the workspace, change role, remove", async ({
  browser,
}) => {
  const hire = `journey-${Date.now()}@example.test`;

  // 1. the owner invites from the Members page and copies the one-time link
  const ownerCtx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  await signIn(ownerCtx, owner);
  const ownerPage = await ownerCtx.newPage();
  await ownerPage.goto("/app/settings/members");
  await ownerPage.getByRole("button", { name: "Invite someone" }).first().click();
  const dialog = ownerPage.getByRole("dialog", { name: "Invite someone" });
  await dialog.getByLabel(/Email address/).fill(hire);
  await dialog.getByLabel("Role").selectOption("member");
  await dialog.getByRole("button", { name: "Create invite link" }).click();
  const ready = ownerPage.getByRole("dialog", { name: "Invitation ready" });
  await ready.getByRole("button", { name: "Copy invite link" }).click();
  const link = await ownerPage.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/invite#token=[0-9a-f]{64}$/);
  await ready.getByRole("button", { name: "Done" }).click();

  // 2. the invitee, with no account, follows the link and creates one
  const hireCtx = await browser.newContext();
  const hirePage = await hireCtx.newPage();
  await hirePage.goto(link);
  await hirePage.getByRole("link", { name: "Create an account" }).click();
  await hirePage.waitForURL(/\/signup\?next=%2Finvite/);
  await expect(hirePage.locator('input[name="captchaToken"]')).not.toHaveValue("", {
    timeout: 20_000,
  });
  await hirePage.getByLabel("Email").fill(hire);
  await hirePage.getByLabel("Password").fill(PASSWORD);
  await hirePage.getByRole("button", { name: /Create account|Sign up/ }).click();
  await expect(hirePage.getByRole("heading", { name: "Check your email" })).toBeVisible({
    timeout: 30_000,
  });

  // 3. the invitee confirms the address; the app's callback signs them in and returns them to the invitation
  const code = await confirmationCode(hire);
  await hirePage.goto(`/auth/callback?next=/invite&code=${code}`);
  await hirePage.waitForURL(/\/invite$/, { timeout: 30_000 });

  // 4. they see the offer and accept, and land in the workspace
  await expect(hirePage.getByRole("heading", { name: "Join E2E Journey Co" })).toBeVisible();
  await hirePage.getByRole("button", { name: "Join E2E Journey Co" }).click();
  await hirePage.waitForURL(/\/app/, { timeout: 30_000 });
  await expect(hirePage.getByText("E2E Journey Co").first()).toBeVisible();
  expect(
    psql(
      `select m.role from public.memberships m join auth.users u on u.id = m.user_id where u.email = '${hire}' and m.organization_id = '${org}'`,
    ),
  ).toBe("member");

  // 5. the owner sees them, changes their role, and removes them
  await ownerPage.reload();
  const people = ownerPage.getByRole("table", { name: "Members of this workspace" });
  const row = people
    .getByRole("row")
    .filter({ hasText: "Member" })
    .filter({ hasNot: ownerPage.getByText("Olive Owner") });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: /Change role/ }).click();
  const roleDialog = ownerPage.getByRole("dialog", { name: /Change role for/ });
  await roleDialog.getByLabel("New role").selectOption("admin");
  await roleDialog.getByRole("button", { name: "Change role" }).click();
  await expect(people.getByRole("row").filter({ hasText: "Admin" })).toHaveCount(1);
  expect(
    psql(
      `select m.role from public.memberships m join auth.users u on u.id = m.user_id where u.email = '${hire}'`,
    ),
  ).toBe("admin");

  await people
    .getByRole("row")
    .filter({ hasText: "Admin" })
    .getByRole("button", { name: /Remove/ })
    .click();
  await ownerPage.getByRole("alertdialog").getByRole("button", { name: "Remove member" }).click();
  await expect(people.getByRole("row").filter({ hasText: "Admin" })).toHaveCount(0);

  // 6. their access is gone: first in the database, then through the API the invitee's own session calls
  await expect
    .poll(
      () =>
        psql(
          `select count(*) from public.memberships m join auth.users u on u.id = m.user_id where u.email = '${hire}'`,
        ),
      { timeout: 10_000 },
    )
    .toBe("0");
  const header = (await hireCtx.cookies())
    .filter((c) => c.name.includes("auth-token") && !c.name.includes("code-verifier"))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  let last = 0;
  await expect
    .poll(
      async () => {
        const res = await fetch("http://localhost:3111/api/v1/customers", {
          headers: { cookie: header, "X-Organization-Id": org },
        });
        last = res.status;
        return res.status;
      },
      { timeout: 10_000, message: "the removed member must be refused" },
    )
    .toBe(404);
  expect(last).toBe(404);
  await api(owner, "GET", "/members", org); // the workspace itself is untouched
  await ownerCtx.close();
  await hireCtx.close();
});
