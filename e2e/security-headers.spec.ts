import { expect, test, type Page } from "@playwright/test";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [SIT-272, SIT-273] The response headers and what they must not break: every page of the guest journey and the sign-in page (with
 * Turnstile) load with the Content-Security-Policy in force and the browser reports no violation; the headers are the ones intended;
 * robots.txt and sitemap.xml come from the configured origin; the account pages and the app are marked noindex.
 */
test.afterEach(async ({ context }) => trackBrowserUser(context));
test.afterAll(cleanUp);

async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
}
const violations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []);

test("the response headers are the intended ones on public, account and app pages", async ({
  page,
}) => {
  for (const path of ["/", "/login", "/privacy", "/api/health"]) {
    const res = await page.request.get(path);
    const h = res.headers();
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"], path).toContain("camera=()");
    const csp = h["content-security-policy"];
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain(
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    );
    expect(csp, path).toContain("connect-src 'self' http://127.0.0.1:54321");
    expect(csp, path).not.toMatch(/unsafe-eval/);
  }
});

test("a guest's whole tour and the sign-in page run under the CSP with no violation", async ({
  page,
}) => {
  await watchViolations(page);
  const seen: string[] = [];
  for (const path of ["/", "/login", "/signup", "/privacy", "/terms"]) {
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2500); // the Turnstile script and iframe load and run after the page
    seen.push(...(await violations(page)).map((v) => `${path}: ${v}`));
  }
  await page.goto("/");
  await page.getByRole("link", { name: "Try Live Demo" }).first().click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
  for (const path of [
    "/app",
    "/app/customers",
    "/app/opportunities?view=board",
    "/app/tasks",
    "/app/quotes",
    "/app/reports",
    "/app/activity",
    "/app/settings",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1500);
    seen.push(...(await violations(page)).map((v) => `${path}: ${v}`));
  }
  expect(seen).toEqual([]);
});

test("robots.txt and sitemap.xml come from the configured origin; account pages and the app are noindex", async ({
  page,
}) => {
  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /app");
  expect(robots).toContain("Disallow: /api/");
  expect(robots).toContain("Sitemap: http://localhost:3111/sitemap.xml");
  const map = await (await page.request.get("/sitemap.xml")).text();
  for (const p of ["/", "/privacy", "/terms"])
    expect(map).toContain(`<loc>http://localhost:3111${p}</loc>`);
  expect(map).not.toContain("/app");
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
});
