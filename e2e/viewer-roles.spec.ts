import { expect, test } from "@playwright/test";
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

/**
 * [SIT-249] Role audit in a real browser: a viewer sees every page but has no control that changes anything (or one that is
 * disabled with its reason), a member cannot reach member management, and the P2 settings pages are 404s while their flags
 * are off, for everyone including guests. The API half of the matrix is `src/lib/permissions/endpoint-matrix.integration.test.ts`.
 */
let owner: Person, viewer: Person, member: Person;
let org = "";
let customerId = "";
let dealId = "";

test.beforeAll(async () => {
  [owner, viewer, member] = await Promise.all([makeUser("ro"), makeUser("rv"), makeUser("rm")]);
  org = await makeWorkspace(owner, "E2E Roles Co");
  addMember(org, viewer, "viewer");
  addMember(org, member, "member");
  customerId = (
    (await (
      await api(owner, "POST", "/customers", org, { displayName: "Roles Customer" })
    ).json()) as { data: { id: string } }
  ).data.id;
  dealId = (
    (await (
      await api(owner, "POST", "/opportunities", org, { customerId, title: "Roles Deal" })
    ).json()) as { data: { id: string } }
  ).data.id;
  await api(owner, "POST", "/tasks", org, {
    title: "Roles Task",
    dueDate: "2020-01-01",
    customerId,
  });
});
test.afterAll(cleanUp);

/** Words that mean "this changes something". An enabled control with one of these, in a viewer's page, is a defect. */
const WRITE_WORDS =
  /^(add|new|create|edit|archive|restore|delete|remove|invite|save|complete|mark|reset|change|revoke|import)\b/i;

test("a viewer's pages offer no control that changes anything", async ({ page, context }) => {
  await signIn(context, viewer);
  const pages = [
    "/app",
    "/app/customers",
    `/app/customers/${customerId}`,
    "/app/opportunities?view=list",
    "/app/opportunities?view=board",
    `/app/opportunities/${dealId}`,
    "/app/tasks",
    "/app/activity",
    "/app/settings/members",
  ];
  const offenders: string[] = [];
  for (const path of pages) {
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(800);
    const controls = await page
      .locator("main button, main a, main [role=checkbox], main [role=menuitem]")
      .evaluateAll((els) =>
        els
          .filter((e) => (e as HTMLElement).offsetParent !== null)
          // the stage chips are read-only links named after the stages ("New (1)"), not an action
          .filter((e) => !e.closest('nav[aria-label="Open a stage in the list"]'))
          .map((e) => ({
            name: (e.getAttribute("aria-label") || (e as HTMLElement).innerText || "")
              .replace(/\s+/g, " ")
              .trim(),
            disabled:
              (e as HTMLButtonElement).disabled || e.getAttribute("aria-disabled") === "true",
          })),
      );
    for (const c of controls)
      if (WRITE_WORDS.test(c.name) && !c.disabled) offenders.push(`${path}: "${c.name}"`);
  }
  expect(offenders).toEqual([]);

  // the disabled ones say why
  await page.goto(`/app/customers/${customerId}`);
  await expect(page.getByRole("button", { name: "Archive" })).toBeDisabled();
  await expect(page.getByText(/You can view this customer but not archive it/)).toBeVisible();
});

test("a viewer cannot pick up or move a card on the board, and the deal does not move", async ({
  page,
  context,
}) => {
  await signIn(context, viewer);
  await page.goto("/app/opportunities?view=board");
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const card = page.getByRole("link", { name: "Roles Deal" });
  await expect(card).toBeVisible();
  await card.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await page.waitForTimeout(600);
  const res = await api(owner, "GET", `/opportunities/${dealId}`, org);
  expect(((await res.json()) as { data: { stage: string } }).data.stage).toBe("new");
  const move = await api(viewer, "POST", `/opportunities/${dealId}/stage`, org, {
    stage: "qualified",
    expectedUpdatedAt: "2020-01-01T00:00:00.000000+00:00",
  });
  expect(move.status).toBe(403);
});

test("a member cannot reach member management: the page is read-only and the API says 403", async ({
  page,
  context,
}) => {
  await signIn(context, member);
  await page.goto("/app/settings/members");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Invite someone/ })).toHaveCount(0);
  await expect(page.getByText("Only owners and admins can change this list.")).toBeVisible();
  expect(
    (await api(member, "POST", "/invitations", org, { email: "x@example.test", role: "member" }))
      .status,
  ).toBe(403);
  expect((await api(member, "PATCH", `/members/${viewer.id}`, org, { role: "admin" })).status).toBe(
    403,
  );
});

test("the P2 settings pages are 404s while their flags are off, for an owner and for a guest", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  for (const path of ["/app/settings/integrations", "/app/settings/billing"]) {
    const res = await page.goto(path);
    expect(res?.status(), `${path} as owner`).toBe(404);
  }
  await expect(page.getByRole("link", { name: "Integrations" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Billing" })).toHaveCount(0);

  const guest = await context.newPage();
  await guest.context().clearCookies();
  await guest.goto("/");
  await guest.getByRole("link", { name: "Try Live Demo" }).first().click();
  await guest.waitForURL(/\/app/, { timeout: 60_000 });
  await trackBrowserUser(context);
  for (const path of ["/app/settings/integrations", "/app/settings/billing"]) {
    const res = await guest.goto(path);
    expect(res?.status(), `${path} as guest`).toBe(404);
  }
});
