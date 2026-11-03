import { expect, test } from "@playwright/test";
import { cleanUp, makeUser, signIn } from "./support/local";

/**
 * Three failures seen on the live site (2026-11-03), each as a browser test:
 *  1. the demo cannot start because the Supabase project has guest sign-in off: the page says so (it used to say the service could
 *     not be reached) and shows the error code; a failed security check and a busy service still get their own words;
 *  2. the confirmation link of an e-mail that was already used or has expired lands on the sign-in page with an explanation;
 *  3. a form left open across a deploy posts a Server Action the new build does not have: the page asks for a reload and does not crash.
 * Supabase Auth is answered by the test (the browser calls it directly), so none of this depends on a project's settings.
 */
test.afterAll(cleanUp);

const authError = (status: number, error_code: string, msg: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ code: status, error_code, msg }),
});

test("demo start: guest sign-in switched off in Supabase is named as such, with the error code, and is not offered as a retry", async ({
  page,
}) => {
  await page.route("**/auth/v1/signup", (route) =>
    route.fulfill(authError(422, "anonymous_provider_disabled", "Anonymous sign-ins are disabled")),
  );
  const warnings: string[] = [];
  page.on("console", (m) => m.type() === "warning" && warnings.push(m.text()));
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "The live demo is switched off right now" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText(/turned off on this site at the moment/)).toBeVisible();
  await expect(page.getByText("Error code: anonymous_provider_disabled")).toBeVisible();
  await expect(page.getByText(/could not reach the demo service/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  expect(warnings.join("\n")).toContain("anonymous_provider_disabled");
});

test("demo start: a failed security check and a busy service each get their own message and a retry", async ({
  page,
}) => {
  let answer = authError(400, "captcha_failed", "captcha protection: request disallowed");
  await page.route("**/auth/v1/signup", (route) => route.fulfill(answer));
  await page.goto("/demo");
  await expect(
    page.getByRole("heading", { name: "We could not confirm you are a person" }),
  ).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  answer = authError(429, "over_request_rate_limit", "rate limit");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "The demo is busy right now" })).toBeVisible({
    timeout: 45_000,
  });
});

test("sign-up link already used or expired: the sign-in page explains it instead of a generic link problem", async ({
  page,
}) => {
  // what the app does with the visit: no code means no sign-in, so it goes to /login
  const res = await page.goto("/auth/callback");
  expect(res?.url()).toMatch(/\/login\?error=callback$/);
  await expect(
    page.getByRole("alert").filter({ hasText: "That link is invalid or has expired" }),
  ).toBeVisible();
  // what Supabase's verify endpoint adds to the address when the one-time token was already consumed
  await page.goto(
    "/login?error=callback#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
  );
  const notice = page.getByRole("alert").filter({ hasText: "already used or has expired" });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("already confirmed");
  await expect(notice).toContainText("sign in");
  await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
});

test("reset password after a deploy: the stale Server Action is explained, nothing crashes, and the form still works for another try", async ({
  page,
  context,
}) => {
  const person = await makeUser("stale");
  await signIn(context, person);
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  let missing = true;
  await page.route("**/reset-password**", (route) => {
    const req = route.request();
    if (missing && req.method() === "POST" && req.headers()["next-action"]) {
      // what a Next.js server answers for an action id it has never seen (a different build)
      return route.fulfill({
        status: 404,
        headers: { "x-nextjs-action-not-found": "1", "content-type": "text/plain" },
        body: "Server action not found.",
      });
    }
    return route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#new-password").fill("a-long-enough-pass");
  await page.locator("#confirm-password").fill("a-long-enough-pass");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(
    page.getByText(/OpsDesk was updated while this page was open/).first(),
  ).toBeVisible();
  await expect(page.getByText(/Nothing was saved/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible(); // still the form, not a crash
  expect(errors.filter((m) => /Something went wrong/.test(m))).toEqual([]);
  // a reload gives a page of the current build, and the real action then runs
  missing = false;
  await page.reload();
  await page.locator("#new-password").fill("a-long-enough-pass");
  await page.locator("#confirm-password").fill("a-long-enough-pass");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).not.toHaveURL(/\/reset-password$/, { timeout: 20_000 });
});
