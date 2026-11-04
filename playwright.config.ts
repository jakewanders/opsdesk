import { defineConfig, devices } from "@playwright/test";
import { localSupabase } from "./src/test/local-supabase";

/**
 * End-to-end tests (SIT-251). They run the PRODUCTION build (`npm run build` first) against the LOCAL Supabase stack
 * (`npm run db:start`); `localSupabase()` refuses any host but localhost. The Turnstile site key is Cloudflare's public
 * always-passes TEST key, which the local auth stack accepts; nothing here can reach production data.
 */
const PORT = 3111;
const supabase = localSupabase();

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  projects: [
    { name: "desktop", testIgnore: /mobile\.spec\.ts/ },
    // Motion: the same accessibility and navigation checks with the system asking for reduced motion, so a view transition or
    // count-up can never be what a check depends on.
    {
      name: "desktop-reduced",
      testMatch: /(accessibility|navigation)\.spec\.ts/,
      use: { reducedMotion: "reduce" },
    },
    // E2E scenario 9: a phone-sized browser (375 x 812, touch), used by e2e/mobile.spec.ts
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: "mobile-reduced",
      testMatch: /mobile\.spec\.ts/,
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      },
    },
  ],
  use: {
    actionTimeout: 15_000,
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `node_modules/.bin/next start -p ${PORT}`,
    url: `http://localhost:${PORT}/privacy`,
    reuseExistingServer: false,
    // Playwright forwards only the server's stderr by default; the info lines (every request) go to stdout and are what the log scan reads (SIT-275)
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: {
      NODE_ENV: "production",
      NEXT_DIST_DIR: ".next-e2e",
      NEXT_PUBLIC_SUPABASE_URL: supabase.apiUrl,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase.publishableKey,
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    },
  },
});
