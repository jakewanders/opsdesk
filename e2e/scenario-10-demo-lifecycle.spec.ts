import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { localSupabase, psql } from "../src/test/local-supabase";
import { cleanUp, trackBrowserUser } from "./support/local";

test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

/**
 * [P-08, PRD 11.4 scenario 10] The demo's life: reset, expiry, cleanup.
 * Test hook for expiry (documented in docs/DEMO.md, "Test hooks for simulating expiry"): the local database's `postgres` role moves
 * `organizations.expires_at` into the past. A browser role cannot. Cleanup is the real `npm run demo:cleanup` entry point.
 */
async function enterDemo(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}
const orgCount = (id: string) =>
  Number(psql(`select count(*) from public.organizations where id = '${id}'`));
function runCleanup(): string {
  const s = localSupabase();
  return execFileSync("npx", ["tsx", "scripts/demo-cleanup.mts"], {
    env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: s.apiUrl, SUPABASE_SECRET_KEY: s.secretKey },
    encoding: "utf8",
  });
}

test("scenario 10: reset restores the sample data, an expired demo is read-only and ends, cleanup removes it once", async ({
  page,
}) => {
  await enterDemo(page);

  // add our own customer, then reset: it is gone and the sample customers are back
  const mine = `Reset Me ${Date.now()}`;
  await page.goto("/app/customers/new");
  await page.getByLabel("Display name").fill(mine);
  await page.getByRole("button", { name: "Add customer" }).click();
  await expect(page.getByRole("heading", { name: new RegExp(mine) })).toBeVisible();
  const orgId = psql(
    `select organization_id from public.customers where display_name = '${mine}'`,
  ).trim();
  const expiryBefore = psql(`select expires_at from public.organizations where id = '${orgId}'`);

  await page.goto("/app/customers");
  await page.getByRole("button", { name: "Reset Demo" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Reset demo" }).click();
  await expect(page.getByRole("alertdialog")).toBeHidden({ timeout: 20_000 });
  await expect
    .poll(() =>
      psql(
        `select count(*) from public.customers where organization_id = '${orgId}' and display_name = '${mine}'`,
      ).trim(),
    )
    .toBe("0");
  expect(
    Number(psql(`select count(*) from public.customers where organization_id = '${orgId}'`)),
  ).toBeGreaterThan(0);
  await expect(page.getByText(mine)).toHaveCount(0);
  // a reset never extends the 24 hours
  expect(psql(`select expires_at from public.organizations where id = '${orgId}'`)).toBe(
    expiryBefore,
  );

  // a second reset straight away is throttled and nothing is lost
  const second = await page.request.post("/api/v1/demo/reset", {
    headers: { "X-Organization-Id": orgId, origin: "http://localhost:3111" },
  });
  expect(second.status()).toBe(429);

  // simulate expiry: reads still work, every write is refused in words, and the app sends the guest to the demo page
  psql(
    `update public.organizations set expires_at = now() - interval '1 minute' where id = '${orgId}'`,
  );
  const write = await page.request.post("/api/v1/customers", {
    headers: { "X-Organization-Id": orgId, origin: "http://localhost:3111" },
    data: { displayName: "After expiry" },
  });
  expect(write.status()).toBe(403);
  expect((await write.json()).error.code).toBe("DEMO_EXPIRED");
  expect(
    Number(psql(`select count(*) from public.customers where display_name = 'After expiry'`)),
  ).toBe(0);
  await page.goto("/app");
  await expect(page).toHaveURL(/\/demo/);
  await expect(page.getByText("Your demo has ended")).toBeVisible();

  // cleanup removes the expired workspace and its guest, and a second run finds nothing more to do
  const first = runCleanup();
  expect(first).toMatch(/[1-9]\d* workspaces? and [1-9]\d* guests? removed, 0 errors/);
  expect(orgCount(orgId)).toBe(0);
  expect(
    Number(psql(`select count(*) from public.customers where organization_id = '${orgId}'`)),
  ).toBe(0);
  expect(runCleanup()).toMatch(/0 workspaces and 0 guests removed, 0 errors/);

  // the people who come next are unaffected: a new visitor gets a working demo
  const fresh = await page.context().browser()!.newContext();
  try {
    const p = await fresh.newPage();
    await enterDemo(p);
    await expect(p.getByRole("heading", { name: "Dashboard" }).first()).toBeVisible();
    await trackBrowserUser(fresh);
  } finally {
    await fresh.close();
  }
});
