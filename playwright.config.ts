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
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: `node_modules/.bin/next start -p ${PORT}`,
    url: `http://localhost:${PORT}/privacy`,
    reuseExistingServer: false,
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
