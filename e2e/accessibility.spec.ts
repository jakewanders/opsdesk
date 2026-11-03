import { expect, test, type Page } from "@playwright/test";
import { axeViolations } from "./support/axe";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-261] WCAG 2.2 AA in a real browser: axe on every P0 page in both themes (contrast and landmarks included), the skip
 * link on every page, and keyboard-only walkthroughs (no mouse) of demo entry, customer create / edit / archive / restore,
 * stage moves (the stage menu and the drag handle's keyboard sensor), task create / complete, reset demo, the theme toggle
 * and the navigation drawer: focus lands where it should, stays inside dialogs, comes back to the trigger, and a destructive
 * or unsaved dialog is not dismissed by accident.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}
const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el
      ? (el.getAttribute("aria-label") ?? el.textContent ?? el.id ?? "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 60)
      : "";
  });
const insideDialog = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest("[role=dialog], [role=alertdialog]"));
/** Tab `n` times and report whether focus ever left the open dialog. */
async function focusStaysInDialog(page: Page, n = 24) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
    if (!(await insideDialog(page))) return false;
  }
  return true;
}
const api = async <T>(page: Page, path: string) =>
  ((await (await page.request.get(`/api/v1${path}`)).json()) as { data: T }).data;

for (const theme of ["light", "dark"] as const) {
  test(`axe: every P0 page has no WCAG 2.2 AA violations, ${theme} theme`, async ({ browser }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({
      baseURL: "http://localhost:3111",
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript((t) => localStorage.setItem("opsdesk-theme", t), theme);
    const page = await context.newPage();
    const found: Record<string, string[]> = {};
    const scan = async (path: string, ready: string) => {
      await page.goto(path);
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^((?!dark).)*$/);
      await page.waitForTimeout(400);
      const v = await axeViolations(page);
      if (v.length) found[path] = v;
    };
    for (const [p, r] of [
      ["/", "h1"],
      ["/login", "h1"],
      ["/signup", "h1"],
      ["/forgot-password", "h1"],
      ["/privacy", "h1"],
      ["/terms", "h1"],
      ["/demo", "h1"],
    ] as const)
      await scan(p, r);
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    await page.waitForURL(/\/app/, { timeout: 60_000 });
    const cid = (await api<Array<{ id: string }>>(page, "/customers?limit=1"))[0].id;
    const oid = (await api<Array<{ id: string }>>(page, "/opportunities?limit=1"))[0].id;
    for (const [p, r] of [
      ["/app", "[aria-label='Key numbers']"],
      ["/app/customers", "table"],
      [`/app/customers/${cid}`, "h1"],
      ["/app/customers/new", "form"],
      [`/app/customers/${cid}/edit`, "form"],
      ["/app/opportunities?view=list", "table"],
      ["/app/opportunities?view=board", "[aria-label='Pipeline board']"],
      [`/app/opportunities/${oid}`, "h1"],
      ["/app/opportunities/new", "form"],
      ["/app/tasks", "table"],
      ["/app/activity", "ol"],
      ["/app/settings", "h1"],
      ["/app/quotes", "h1"],
      ["/app/reports", "h1"],
      ["/app/quotes/new", "form"],
      ["/app/customers/import", "h1"],
      ["/app/opportunities/new", "form"],
      [`/app/opportunities/${oid}/edit`, "form"],
      ["/app/settings/members", "h1"],
      ["/app/settings/organization", "h1"],
      ["/app/settings/billing", "h1"],
      ["/app/settings/integrations", "h1"],
      ["/app/workspaces", "h1"],
    ] as const)
      await scan(p, r);
    // the surfaces that open on top of a page
    await page.goto("/app/tasks");
    await page.getByRole("button", { name: "Add task" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.waitForTimeout(400);
    const drawer = await axeViolations(page);
    if (drawer.length) found["task drawer"] = drawer;
    await trackBrowserUser(context);
    expect(found).toEqual({});
  });
}

test("a skip link is the first Tab stop on every page and moves focus to the main content", async ({
  page,
}) => {
  await enterDemo(page);
  const paths = [
    "/",
    "/login",
    "/signup",
    "/privacy",
    "/terms",
    "/app",
    "/app/customers",
    "/app/customers/new",
    "/app/opportunities",
    "/app/tasks",
    "/app/activity",
    "/app/settings",
  ];
  for (const path of paths) {
    await page.goto(path);
    await page.locator("h1").first().waitFor();
    await page.keyboard.press("Tab");
    expect(await focusedName(page), `${path}: first Tab stop`).toMatch(/skip to main content/i);
    await page.keyboard.press("Enter");
    expect(
      await page.evaluate(() => document.activeElement?.id),
      `${path}: focus after Enter`,
    ).toBe("main-content");
  }
});

test("every Tab stop on the main screens has a visible focus indicator, in both themes", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({
      baseURL: "http://localhost:3111",
      viewport: { width: 1280, height: 900 },
    });
    await context.addInitScript((t) => localStorage.setItem("opsdesk-theme", t), theme);
    const page = await context.newPage();
    await enterDemo(page);
    for (const path of ["/app", "/app/customers", "/app/opportunities?view=board", "/app/tasks"]) {
      await page.goto(path);
      await page.locator("h1").first().waitFor();
      await page.waitForTimeout(500);
      const bad: string[] = [];
      for (let i = 0; i < 45; i++) {
        await page.keyboard.press("Tab");
        const visible = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return "none";
          const s = getComputedStyle(el);
          const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
          const ring = s.boxShadow !== "none" && /\d/.test(s.boxShadow);
          const underline = s.textDecorationLine.includes("underline");
          return outline || ring || underline
            ? "ok"
            : `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}`;
        });
        if (visible !== "ok" && visible !== "none") bad.push(visible);
      }
      expect(bad, `${theme} ${path}: Tab stops with no visible focus`).toEqual([]);
    }
    await trackBrowserUser(context);
    await context.close();
  }
});

test("customer create, edit, archive and restore by keyboard: errors are announced and linked, dialogs hold and return focus", async ({
  page,
}) => {
  await enterDemo(page);
  await page.goto("/app/customers/new");
  await page.waitForLoadState("networkidle"); // hydrated: a key pressed earlier would submit the form natively
  await page.getByLabel("Display name").focus();
  // submit empty with the keyboard: the error summary is an alert that takes focus, and the field is linked to its message
  await page.keyboard.press("Enter");
  const summary = page.locator("[role=alert]:not(#__next-route-announcer__)").first();
  await expect(summary).toBeVisible();
  await expect(summary).toContainText("There is a problem");
  const field = page.getByLabel("Display name");
  // focus goes to the first invalid field (so the person can type the fix at once); the summary is the announcement
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const described = await field.getAttribute("aria-describedby");
  expect(described).toBeTruthy();
  for (const id of described!.split(" ")) await expect(page.locator(`[id="${id}"]`)).toHaveCount(1);
  expect(await page.locator(`[id="${described!.split(" ").at(-1)}"]`).innerText()).toMatch(/\S/);
  // fix it by keyboard and submit
  const name = `Keyboard Co ${Date.now()}`;
  await field.focus();
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: new RegExp(name) })).toBeVisible();
  // archive: the confirmation holds focus, Escape cancels without acting and focus returns to the trigger
  const archive = page.getByRole("button", { name: "Archive" });
  await archive.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  expect(await insideDialog(page)).toBe(true);
  expect(await focusStaysInDialog(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(archive).toBeFocused();
  await expect(page.getByText("This customer is archived.")).toBeHidden();
  // confirm with the keyboard: Tab to the confirm button, Enter
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Tab"); // from Cancel to the destructive button
  await expect(dialog.getByRole("button", { name: "Archive customer" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("This customer is archived.")).toBeVisible();
  // restore by keyboard
  const restore = page.getByRole("button", { name: "Restore" });
  await restore.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("This customer is archived.")).toBeHidden();
});

test("stage moves by keyboard: the stage menu, and the drag handle's keyboard sensor with its announcements", async ({
  page,
}) => {
  await enterDemo(page);
  const deals = await api<Array<{ id: string; title: string; stage: string }>>(
    page,
    "/opportunities?limit=100",
  );
  const menuDeal = deals.find((d) => d.stage === "qualified")!;
  const dragDeal = deals.find((d) => d.stage === "new")!;
  await page.goto("/app/opportunities?view=board");
  await page.getByLabel(`Move ${menuDeal.title} to another stage`).waitFor();
  await page.waitForLoadState("networkidle");
  // the stage menu: focus the select, ArrowDown picks the next stage (Proposal)
  const select = page.getByLabel(`Move ${menuDeal.title} to another stage`);
  await select.focus();
  await page.keyboard.type("Proposal"); // type-ahead picks the option; works whether the platform opens the list on arrow keys or not
  await expect
    .poll(
      async () =>
        (await api<Array<{ id: string; stage: string }>>(page, "/opportunities?limit=100")).find(
          (d) => d.id === menuDeal.id,
        )?.stage,
      { timeout: 15_000 },
    )
    .toBe("proposal");
  // the drag handle: Space lifts, ArrowRight moves one stage, Space drops; every step is announced in dnd-kit's live region
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    const watch = () => {
      const region = document.querySelector("[id^=DndLiveRegion]");
      if (!region) return;
      const text = region.textContent?.trim();
      if (text && w.__said.at(-1) !== text) w.__said.push(text);
    };
    new MutationObserver(watch).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });
  await page.waitForLoadState("networkidle"); // the board has finished re-rendering after the first move
  await page.waitForTimeout(800); // let the board settle: a key pressed while cards are being replaced is lost
  const handle = page.getByRole("button", { name: `Drag ${dragDeal.title}` });
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(handle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as unknown as { __said: string[] }).__said)).join(" | "),
    )
    .toContain(`${dragDeal.title} is over Qualified`);
  await page.keyboard.press("Space");
  await expect
    .poll(
      async () =>
        (await api<Array<{ id: string; stage: string }>>(page, "/opportunities?limit=100")).find(
          (d) => d.id === dragDeal.id,
        )?.stage,
      { timeout: 15_000 },
    )
    .toBe("qualified");
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(said.join(" | ")).toContain(`Picked up ${dragDeal.title}`);
  expect(said.join(" | ")).toMatch(new RegExp(`${dragDeal.title} is over Qualified`));
  expect(said.join(" | ")).toMatch(new RegExp(`${dragDeal.title}.*(dropped|moved)`, "i"));
});

test("task drawer by keyboard: focus is held, unsaved work is not discarded by Escape, focus returns to the trigger; a task is completed with Enter", async ({
  page,
}) => {
  await enterDemo(page);
  await page.goto("/app/tasks");
  const add = page.getByRole("button", { name: "Add task" }).first();
  await add.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  expect(await insideDialog(page)).toBe(true);
  expect(await focusStaysInDialog(page)).toBe(true);
  // clean drawer: Escape closes and focus goes back to the button that opened it
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(add).toBeFocused();
  // dirty drawer: Escape asks first, and "keep editing" leaves the work in place
  await page.keyboard.press("Enter");
  await expect(drawer).toBeVisible();
  await page.getByLabel(/^Title/).focus();
  await page.keyboard.type("Typed by keyboard");
  await page.keyboard.press("Escape");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toBeVisible();
  await expect(page.locator("[role=dialog]")).toBeAttached(); // still there, behind the question
  await confirm.getByRole("button", { name: /Keep editing|Cancel/ }).click();
  await expect(page.getByLabel(/^Title/)).toHaveValue("Typed by keyboard");
  // save with the keyboard, then complete a task with Enter
  await page.getByLabel(/^Title/).focus();
  await page.keyboard.press("Enter");
  await expect(drawer).toBeHidden();
  await expect(page.getByText("Typed by keyboard").first()).toBeVisible();
  const done = page.getByRole("button", { name: "Mark Typed by keyboard complete" });
  await done.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Reopen Typed by keyboard" })).toBeVisible();
});

test("Reset Demo and the theme toggle work from the keyboard", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/app");
  const reset = page.getByRole("button", { name: "Reset Demo" });
  await reset.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  expect(await focusStaysInDialog(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(reset).toBeFocused();
  // the theme toggle changes the theme and keeps its place
  const toggle = page.getByRole("button", { name: /^Theme:/ });
  await toggle.focus();
  const before = await page.locator("html").getAttribute("class");
  await page.keyboard.press("Enter");
  await expect.poll(async () => await page.locator("html").getAttribute("class")).not.toBe(before);
  await expect(page.getByRole("button", { name: /^Theme:/ })).toBeFocused();
});

test.describe("navigation drawer on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  test("opens from the keyboard, holds focus, closes with Escape and returns focus to its button", async ({
    page,
  }) => {
    await enterDemo(page);
    await page.goto("/app");
    const open = page.getByRole("button", { name: "Open navigation" });
    await open.focus();
    await page.keyboard.press("Enter");
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    expect(await insideDialog(page)).toBe(true);
    expect(await focusStaysInDialog(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();
  });
});
