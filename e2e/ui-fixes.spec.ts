import { expect, test, type Page } from "@playwright/test";
import { api, cleanUp, makeUser, makeWorkspace, signIn, type Person } from "./support/local";

/**
 * Seven reported UI problems, each proven in a real browser: dropdown arrow spacing (a1), "Optional" hints without a period (a2),
 * the drop animation landing in the NEW column (a3), instant "Add opportunity" (a4), equal spacing in the add-opportunity form (a5),
 * tab changes served from the cache (a6) and tabs that never overlap on a phone (a7).
 */
let owner: Person;
let org = "";
let customerId = "";
const data = async (res: Response) => ((await res.json()) as { data: { id: string } }).data;

test.beforeAll(async () => {
  owner = await makeUser("uifix");
  org = await makeWorkspace(owner, "E2E UI Fixes Co");
  customerId = (
    await data(await api(owner, "POST", "/customers", org, { displayName: "Fixes Customer" }))
  ).id;
  await api(owner, "POST", "/opportunities", org, {
    customerId,
    title: "Drag Me Deal",
    amountCents: 120000,
    stage: "new",
  });
  await api(owner, "POST", "/tasks", org, { title: "Fixes Task", customerId });
  await api(owner, "POST", "/quotes", org, {
    customerId,
    title: "Fixes Quote",
    taxRateBps: 0,
    discountCents: 0,
    items: [{ description: "Work", quantity: 1, unitPriceCents: 10000 }],
  });
});
test.afterAll(cleanUp);
test.beforeEach(async ({ context }) => signIn(context, owner));

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on the page`);
  return b;
};

test("a1 a5: dropdown arrow sits away from the edge; the four fields share a grid", async ({
  page,
}) => {
  await page.goto("/app/opportunities/new");
  const stage = page.locator("#opportunity-stage");
  await expect(stage).toBeVisible();
  const style = await stage.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      appearance: s.appearance,
      padRight: parseFloat(s.paddingRight),
      pos: s.backgroundPosition,
    };
  });
  expect(style.appearance).toBe("none");
  expect(style.padRight).toBeGreaterThanOrEqual(32);
  expect(style.pos).toContain("calc(100% - 12px)"); // the arrow is 12px from the right edge

  // a5: Stage / Amount share a row, Probability / Close date share the next; controls line up and have one height and one gap
  const ids = ["stage", "amount", "probability", "expectedCloseDate"];
  const r = await Promise.all(ids.map((i) => box(page, `#opportunity-${i}`)));
  expect(Math.abs(r[0].y - r[1].y)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r[2].y - r[3].y)).toBeLessThanOrEqual(0.5);
  for (const b of r) expect(Math.abs(b.height - r[0].height)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r[0].x - r[2].x)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r[1].x - r[3].x)).toBeLessThanOrEqual(0.5);
});

test("a2: optional fields say Optional, with no full stop", async ({ page }) => {
  await page.goto("/app/tasks");
  await page.getByRole("button", { name: "Add task" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/^Optional$/).first()).toBeVisible();
  expect(await dialog.innerText()).not.toMatch(/Optional\./);
});

test("a3: a dropped card flies to the new column, never back to the old one", async ({ page }) => {
  await page.goto("/app/opportunities");
  const handle = page.getByRole("button", { name: "Drag Drag Me Deal" });
  await expect(handle).toBeVisible();
  const from = await box(page, 'section[data-stage="new"]');
  const to = await box(page, 'section[data-stage="proposal"]');
  const h = (await handle.boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __samples: Array<{ x: number; t: number }> };
    w.__samples = [];
    const tick = () => {
      for (const el of Array.from(document.querySelectorAll("div"))) {
        if (
          getComputedStyle(el).position === "fixed" &&
          el.getBoundingClientRect().width >= 20 && // not dnd-kit's 1px live region
          el.textContent?.includes("Drag Me Deal") &&
          !el.closest("section")
        ) {
          w.__samples.push({ x: el.getBoundingClientRect().left, t: performance.now() });
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 40, h.y + 40, { steps: 4 });
  // release over the middle of the Proposal column
  await page.mouse.move(to.x + to.width / 2, to.y + 200, { steps: 12 });
  const release = await page.evaluate(() => performance.now());
  await page.mouse.up();
  await expect(
    page.locator('section[data-stage="proposal"]').getByRole("link", { name: "Drag Me Deal" }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  const samples = await page.evaluate(
    () => (window as unknown as { __samples: Array<{ x: number; t: number }> }).__samples,
  );
  const after = samples.filter((s) => s.t >= release);
  expect(after.length).toBeGreaterThan(0);
  // after release the overlay is never back over the old column, and it ends inside the new one
  for (const s of after) expect(s.x).toBeGreaterThan(from.x + from.width);
  const last = after[after.length - 1];
  expect(last.x).toBeGreaterThanOrEqual(to.x - 1);
  expect(last.x).toBeLessThanOrEqual(to.x + to.width);
});

test("a4 a6: tabs open from what was fetched at start; nothing waits on a skeleton", async ({
  page,
}) => {
  const calls: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/v1/")) {
      calls.push(u.pathname + u.search);
    }
  });
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // the startup prefetch has fetched every tab's list
  await expect
    .poll(() =>
      [
        "/api/v1/tasks",
        "/api/v1/quotes",
        "/api/v1/customers",
        "/api/v1/activity",
        "/api/v1/customers?limit=100",
      ].every((p) => calls.some((c) => c.startsWith(p))),
    )
    .toBe(true);
  await page.waitForTimeout(1500); // let the router prefetch settle too
  calls.length = 0;

  for (const [link, heading, row] of [
    ["Tasks", "Tasks", "Fixes Task"],
    ["Quotes", "Quotes", "Fixes Quote"],
    ["Customers", "Customers", "Fixes Customer"],
  ] as const) {
    const t0 = Date.now();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: link }).click();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    await expect(page.getByText(row).first()).toBeVisible();
    // the rows are the cached ones: no skeleton, and no second read of the same list (it is fresh)
    expect(await page.locator('[aria-busy="true"]').count()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
  }
  const listReads = calls.filter((c) => /^\/api\/v1\/(tasks|quotes|customers)\?/.test(c));
  expect(listReads).toEqual([]);

  // a4: the Add button answers at once
  await page.goto("/app/opportunities");
  await page.evaluate(() => {
    const w = window as unknown as { __marks: Record<string, number> };
    w.__marks = {};
    const t0 = performance.now();
    document.addEventListener("click", () => (w.__marks.click = performance.now() - t0), true);
    setInterval(() => {
      if (!w.__marks.skeleton && document.body.innerText.includes("Loading page"))
        w.__marks.skeleton = performance.now() - t0;
      if (!w.__marks.form && document.querySelector("form[aria-label='Add opportunity']"))
        w.__marks.form = performance.now() - t0;
    }, 4);
  });
  await page
    .getByRole("link", { name: /Add opportunity/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Add opportunity" })).toBeVisible();
  await page.waitForTimeout(100);
  const marks = await page.evaluate(
    () => (window as unknown as { __marks: Record<string, number> }).__marks,
  );
  // from the click event to the form on screen (not Playwright's own wait before it clicks)
  expect(marks.form - marks.click).toBeLessThan(400);
  console.log(`add-opportunity: click to form ${Math.round(marks.form - marks.click)}ms`);
});

test.describe("a7: tabs on a phone", () => {
  test.use({ viewport: { width: 320, height: 700 } });
  test("customer tabs never overlap and scroll sideways", async ({ page }) => {
    await page.goto(`/app/customers/${customerId}`);
    const list = page.getByRole("tablist", { name: "Customer sections" });
    await expect(list).toBeVisible();
    const tabs = await list.getByRole("tab").all();
    expect(tabs.length).toBeGreaterThanOrEqual(4);
    const rects = await Promise.all(tabs.map((t) => t.boundingBox()));
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i]!.x).toBeGreaterThanOrEqual(rects[i - 1]!.x + rects[i - 1]!.width - 0.5);
    }
    // no tab's text spills out of its own box
    for (const t of tabs)
      expect(await t.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    // wider than the screen, so the row scrolls instead of squeezing
    const scrolls = await list.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(scrolls).toBe(true);
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(pageOverflow).toBe(false);
    // the last tab can be reached
    await tabs[tabs.length - 1].scrollIntoViewIfNeeded();
    await tabs[tabs.length - 1].click();
    await expect(tabs[tabs.length - 1]).toHaveAttribute("aria-selected", "true");
  });

  test("no page has a tab row, nav or button group that overlaps itself", async ({ page }) => {
    for (const path of [
      "/app",
      "/app/customers",
      "/app/opportunities",
      "/app/tasks",
      "/app/quotes",
      "/app/reports",
      "/app/activity",
      "/app/settings/organization",
      "/app/settings/members",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overlaps = await page.evaluate(() => {
        const bad: string[] = [];
        const groups = document.querySelectorAll('[role="tablist"], [role="group"], main nav');
        groups.forEach((g) => {
          const kids = Array.from(g.children).filter((k) => (k as HTMLElement).offsetParent);
          const rs = kids.map((k) => k.getBoundingClientRect());
          for (let i = 0; i < rs.length; i++)
            for (let j = i + 1; j < rs.length; j++) {
              const a = rs[i];
              const b = rs[j];
              const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (w > 1 && hh > 1)
                bad.push(
                  `${g.getAttribute("aria-label") ?? g.tagName}: ${kids[i].textContent} / ${kids[j].textContent}`,
                );
            }
        });
        return bad;
      });
      expect(overlaps, path).toEqual([]);
      const pageOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      );
      expect(pageOverflow, `${path} scrolls sideways`).toBe(false);
    }
  });
});
