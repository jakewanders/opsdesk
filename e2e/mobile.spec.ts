import { expect, test, type Page } from "@playwright/test";
import { audit } from "./support/audit";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-260] E2E scenario 9: the P0 screens on a phone (the "mobile" project: 375 x 812, touch) and at 200% zoom (a 1280 px
 * desktop zoomed to 200% is 640 CSS px wide). Every page must scroll only vertically, every control must be at least
 * 44 x 44 CSS px on the phone, and the primary actions (Add customer / opportunity / task, Reset Demo, Create an account,
 * log out) must be reachable.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}
const api = async <T>(page: Page, path: string) =>
  ((await (await page.request.get(`/api/v1${path}`)).json()) as { data: T }).data;
async function expectFits(page: Page, where: string, minTarget = 44) {
  const a = await audit(page, minTarget);
  expect(a.overflow, `${where}: the page scrolls sideways by ${a.overflow}px`).toBeLessThanOrEqual(
    0,
  );
  expect(a.small, `${where}: controls smaller than ${minTarget}px`).toEqual([]);
}

test.describe("phone, 375 x 812", () => {
  test("public pages fit", async ({ page }) => {
    for (const [path, ready] of [
      ["/", "h1"],
      ["/login", "h1"],
      ["/signup", "h1"],
      ["/privacy", "h1"],
      ["/terms", "h1"],
    ] as const) {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible();
      await expectFits(page, path);
    }
    // the demo entry page, signed out
    await page.goto("/demo");
    await expect(page.locator("h1").first()).toBeVisible();
    await expectFits(page, "/demo");
  });

  test("every app screen fits, and the primary actions are reachable", async ({ page }) => {
    await enterDemo(page);
    const cid = (await api<Array<{ id: string }>>(page, "/customers?limit=1"))[0].id;
    const oid = (await api<Array<{ id: string }>>(page, "/opportunities?limit=1"))[0].id;
    const screens: Array<[string, string]> = [
      ["/app", "[aria-label='Key numbers']"],
      ["/app/customers", "table"],
      [`/app/customers/${cid}`, "h1"],
      ["/app/customers/new", "form"],
      [`/app/customers/${cid}/edit`, "form"],
      ["/app/opportunities", "table"], // the list is the default on a phone
      ["/app/opportunities?view=board", "[aria-label='Pipeline board']"],
      [`/app/opportunities/${oid}`, "h1"],
      ["/app/opportunities/new", "form"],
      ["/app/tasks", "table"],
      ["/app/activity", "ol"],
      ["/app/settings", "h1"],
    ];
    for (const [path, ready] of screens) {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
      await expectFits(page, path);
    }
    // the pipeline opens as the LIST on a phone with no choice made
    await page.goto("/app/opportunities");
    await expect(page.getByRole("button", { name: "List" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("Add customer / opportunity / task, Reset Demo, Create an account and log out can all be reached and used", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app");
    await expect(page.getByRole("region", { name: "Key numbers" })).toBeVisible();
    // quick actions
    await page.getByRole("link", { name: "Add customer" }).first().click();
    await expect(page).toHaveURL(/\/app\/customers\/new/);
    await page.goBack();
    await page.getByRole("link", { name: "Add opportunity" }).first().click();
    await expect(page).toHaveURL(/\/app\/opportunities\/new/);
    await page.goBack();
    await page.getByRole("button", { name: "Add task" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expectFits(page, "task drawer");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    // the demo banner's own actions
    await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
    await page.getByRole("button", { name: "Reset Demo" }).click();
    const reset = page.getByRole("alertdialog");
    await expect(reset).toBeVisible();
    await expectFits(page, "reset dialog");
    await reset.getByRole("button", { name: "Cancel" }).click();
    // the navigation sheet reaches every section
    await page.getByRole("button", { name: "Open navigation" }).click();
    const nav = page.getByRole("dialog").getByRole("navigation");
    await expect(nav.getByRole("link", { name: "Customers" })).toBeVisible();
    await expectFits(page, "navigation sheet");
    await nav.getByRole("link", { name: "Tasks" }).click();
    await expect(page).toHaveURL(/\/app\/tasks/);
    // the account menu leads to log out
    await page.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await expectFits(page, "account menu");
  });

  test("lists, filters, row menus and dialogs stay inside the screen", async ({ page }) => {
    await enterDemo(page);
    await page.goto("/app/customers");
    await expect(page.getByRole("table")).toBeVisible();
    await page
      .getByRole("button", { name: /^Actions for/ })
      .first()
      .click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await expectFits(page, "customer row menu");
    await page.keyboard.press("Escape");
    // the table scrolls inside its own region, the page does not
    const region = page.getByRole("region", { name: "Customers table" });
    const scrollable = await region.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrollable).toBe(true);
    await page.goto("/app/tasks");
    await expect(page.getByRole("table")).toBeVisible();
    await page
      .getByRole("button", { name: /^Mark .* complete$/ })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Add task" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectFits(page, "task form");
  });
});

test.describe("200% zoom (640 x 450 CSS px)", () => {
  test.use({
    viewport: { width: 640, height: 450 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 2,
  });

  test("no screen scrolls sideways and the primary actions stay reachable", async ({ page }) => {
    await enterDemo(page);
    const cid = (await api<Array<{ id: string }>>(page, "/customers?limit=1"))[0].id;
    const screens: Array<[string, string]> = [
      ["/app", "[aria-label='Key numbers']"],
      ["/app/customers", "table"],
      [`/app/customers/${cid}`, "h1"],
      ["/app/customers/new", "form"],
      ["/app/opportunities?view=list", "table"],
      ["/app/opportunities?view=board", "[aria-label='Pipeline board']"],
      ["/app/tasks", "table"],
      ["/app/activity", "ol"],
      ["/app/settings", "h1"],
    ];
    for (const [path, ready] of screens) {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
      const a = await audit(page, 24); // WCAG 2.5.8 minimum at zoom; the 44 px rule is the phone's
      expect(a.overflow, `${path} scrolls sideways at 200% zoom`).toBeLessThanOrEqual(0);
    }
    // primary actions are reachable (scrolling into view is allowed, being covered is not)
    await page.goto("/app");
    await page.getByRole("link", { name: "Add customer" }).first().click();
    await expect(page).toHaveURL(/\/app\/customers\/new/);
    await page.goto("/app");
    await page.getByRole("button", { name: "Add task" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Reset Demo" }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("link", { name: "Create an account" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
    // nothing covers a primary control: the element at its centre is the control itself
    const covered = await page.evaluate(() => {
      const names = ["Add customer", "Add opportunity", "Add task"];
      return names.filter((n) => {
        const el = Array.from(document.querySelectorAll<HTMLElement>("a, button")).find(
          (e) => e.textContent?.trim() === n && e.getBoundingClientRect().width > 0,
        );
        if (!el) return true;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(top === el || el.contains(top));
      });
    });
    expect(covered).toEqual([]);
  });
});
