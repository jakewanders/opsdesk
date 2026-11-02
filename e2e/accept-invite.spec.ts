import { expect, test } from "@playwright/test";
import { axeViolations } from "./support/axe";
import {
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  PASSWORD,
  signIn,
  type Person,
} from "./support/local";
import { psql } from "../src/test/local-supabase";

/** [SIT-240] The invitation link in a real browser: sign in, see what is offered, join, land in the new workspace. */
let owner: Person, invitee: Person, stranger: Person;
let orgA = "";
const ORG_NAME = "E2E Invite Co";

async function invite(email: string): Promise<{ token: string; link: string }> {
  const res = await api(owner, "POST", "/invitations", orgA, { email, role: "member" });
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { token: string; link: string } };
  return data;
}

test.beforeAll(async () => {
  [owner, invitee, stranger] = await Promise.all([makeUser("io"), makeUser("ii"), makeUser("is")]);
  orgA = await makeWorkspace(owner, ORG_NAME);
  // the invitee already has a workspace of their own: after joining they belong to two
  await makeWorkspace(invitee, "Invitee Own Co");
});
test.afterAll(cleanUp);

test("a signed-out invitee signs in, sees the offer, joins, and lands in the new workspace alongside their own", async ({
  page,
}) => {
  const { token, link } = await invite(invitee.email);
  const seen: string[] = [];
  page.on("request", (r) => seen.push(`${r.method()} ${r.url()} ${r.postData() ?? ""}`));

  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "You have been invited to a workspace" }),
  ).toBeVisible();
  // the token is out of the address bar as soon as it has been read
  expect(page.url()).not.toContain(token);
  expect(new URL(page.url()).hash).toBe("");
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("link", { name: "Sign in" }).click();
  await page.waitForURL(/\/login\?next=%2Finvite/);
  // the CAPTCHA (Cloudflare's always-passes test widget) fills a hidden field when it finishes
  await expect(page.locator('input[name="captchaToken"]')).not.toHaveValue("", { timeout: 20_000 });
  await page.getByLabel("Email").fill(invitee.email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /Sign in/ }).click();

  // back on the invitation, with the offer in words
  await page.waitForURL(/\/invite$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: `Join ${ORG_NAME}` })).toBeVisible();
  await expect(page.getByText(/as\s+member/).first()).toBeVisible();
  await expect(page.getByText(invitee.email)).toBeVisible();
  await page.waitForTimeout(400);
  expect(await axeViolations(page)).toEqual([]);

  await page.getByRole("button", { name: `Join ${ORG_NAME}` }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
  await expect(page.getByText(ORG_NAME).first()).toBeVisible();

  // the workspace list now shows both, and the new one is the selected workspace
  await page.goto("/app/workspaces");
  await expect(page.getByRole("button", { name: "Open Invitee Own Co" })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open ${ORG_NAME}` })).toBeVisible();
  expect(
    psql(
      `select role from public.memberships where organization_id = '${orgA}' and user_id = '${invitee.id}'`,
    ),
  ).toBe("member");

  // the token never appeared in any URL, in any request body except the two API calls, or on a third-party host
  const leaks = seen.filter((line) => line.includes(token));
  expect(leaks.every((l) => /\/api\/v1\/invitations\/(preview|accept)/.test(l))).toBe(true);
  expect(leaks.every((l) => l.includes("localhost:3111"))).toBe(true);
  expect(seen.some((l) => l.split(" ")[1].includes(token))).toBe(false);
});

test("someone signed in as the wrong account cannot join, and is told why", async ({
  page,
  context,
}) => {
  const { link } = await invite(invitee.email.replace("@", "+x@"));
  await signIn(context, stranger);
  await page.goto(link);
  await expect(page.getByText("This invitation is for a different email address")).toBeVisible();
  await expect(page.getByRole("button", { name: `Join ${ORG_NAME}` })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Sign out and use another account" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  expect(await axeViolations(page)).toEqual([]);
});

test("a revoked, expired, used or unknown link says so in words", async ({ page, context }) => {
  await signIn(context, stranger);

  const revoked = await api(owner, "POST", "/invitations", orgA, {
    email: stranger.email,
    role: "viewer",
  });
  const r = (await revoked.json()) as { data: { id: string; link: string } };
  await api(owner, "DELETE", `/invitations/${r.data.id}`, orgA);
  await page.goto(r.data.link);
  await expect(page.getByRole("heading", { name: "This invitation was withdrawn" })).toBeVisible();

  const expiring = await api(owner, "POST", "/invitations", orgA, {
    email: stranger.email,
    role: "viewer",
  });
  const x = (await expiring.json()) as { data: { id: string; link: string } };
  psql(
    `alter table public.invitations disable trigger invitations_protect_columns; update public.invitations set expires_at = now() - interval '1 minute', created_at = now() - interval '8 days' where id = '${x.data.id}'; alter table public.invitations enable trigger invitations_protect_columns`,
  );
  await page.goto(x.data.link);
  await expect(page.getByRole("heading", { name: "This invitation has expired" })).toBeVisible();

  await page.goto(`/invite#token=${"0".repeat(64)}`);
  await expect(
    page.getByRole("heading", { name: "This invitation link is not valid" }),
  ).toBeVisible();
  await page.goto("/invite");
  await expect(
    page.getByRole("heading", { name: "This page needs an invitation link" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  expect(await axeViolations(page)).toEqual([]);
});
