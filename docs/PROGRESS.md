# Progress log

Real command output only. Nothing here is a claim of completion until the checks listed under it have been run; a milestone section holds its milestone-level check results once its last issue is finished. Per-issue entries are added in the order issues are finished. Pending issues that Linear could not hold (`P-01` to `P-23`, see the Pending Issues document) are tracked here by their key when worked.

## Waiting on Jake

Items only Jake can unblock. Each is also an action item in the tracker.

- **SIT-177** (Netlify deploy preview; blocks SIT-213, 272, 273, 274): create the Netlify site from `jakewanders/opsdesk` and enable Deploy Previews (steps in `docs/DEPLOYMENT.md`), then share the site name and assigned `*.netlify.app` hostname. Do not attach `opsdesk.sitelaunch.dev` yet.
- **SIT-168 (hosted part)**: create a Cloudflare Turnstile widget for `opsdesk.sitelaunch.dev`; in the hosted Supabase project turn on anonymous sign-ins and Turnstile CAPTCHA with the production secret and review the anonymous rate limit; set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in Netlify. Checklist in `docs/DEMO.md`; tracked as P-14. Does not block local work.

## M0 — Foundation & Application Architecture

Milestone-level checks: not yet run. M0 is still open.

### SIT-150 — Bootstrap Next.js (done)

- `rm -rf node_modules .next && npm ci && npm run build`: succeeded (Next 16.4.3, routes `/` and `/_not-found` static).
- `npm run typecheck` (`tsc --noEmit`, `strict: true`): no errors. `grep` for `any` in `src/`: none.
- `npm run lint`: clean.
- `npm run dev`: `curl http://localhost:3000` returned the placeholder `<h1>OpsDesk</h1>`.
- `npm audit`: 16 moderate advisories in the default scaffold's dependency tree, not addressed here (no `--force` upgrades).
- No `.env*` or secret files in the tree.

### SIT-156 — ESLint, Prettier, Vitest (done)

- `rm -rf node_modules && npm ci` then `npm run lint`, `format:check`, `typecheck`, `test:unit`: all pass (2 files, 4 tests).
- Negative check: `export const bad = (x: any) => x;` made `npm run lint` fail with `@typescript-eslint/no-explicit-any` (1 error); file removed.
- Negative check: a deliberately failing test made `npm run test:unit` exit 1 (1 failed, 4 passed); file removed.
- `npm run test:coverage` runs (v8 reporter): All files 50% stmts on the sample code.

### SIT-159 — shadcn/ui, design tokens, persisted theme (done)

- `npm run test:unit`: 4 files, 57 tests pass (light and dark token contrast: all text pairs >= 4.5:1, control borders and rings >= 3:1; ThemeToggle: default light, cycle and persist, restore stored dark).
- Mutation check: changing `--muted-foreground` to `#b0aca5` made 2 contrast tests fail; reverted.
- `npm run lint`, `format:check`, `typecheck`, `build`: pass.
- Browser check on `npm run dev` (Playwright): clicking the toggle set `html.dark` and `localStorage opsdesk-theme=dark`; after reload the page was still dark (body background `rgb(20, 20, 19)`), and the inline theme script precedes `<main>` in the HTML. Computed focus ring on the toggle: solid `rgb(76, 195, 180)` 3px. IBM Plex Sans applied.
- Not done here: Lighthouse/axe scores (later accessibility issues, SIT-175 and P-09).

### SIT-160 — Local Supabase, migrations, seed (done)

Done and verified without Docker:

- `npx supabase init` committed `supabase/config.toml` (CLI 2.122.0); `supabase/migrations/20261101000000_baseline.sql`, `supabase/seed.sql`, `supabase/tests/`.
- Baseline migration and seed applied twice in a row to an in-process Postgres (PGlite, scratch copy, not a project dependency): both passes succeeded, `pg_trgm` installed in schema `extensions`, `gen_random_uuid()` available. This is a syntax and idempotence check only, not a Supabase run.
- `npm run db:reset` guard: `NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co` exits 1 with a refusal; `--linked` exits 1; 7 unit tests in `scripts/lib/assert-local-db.test.ts` pass.
- README documents the local steps and type generation.

Verified once Docker was installed (Docker 29.9.2; Docker Desktop's CLI lives in `~/.docker/bin`, which is not on the default PATH):

- `npm run db:start`: all Supabase containers came up healthy (db, auth, rest, studio, kong, storage, realtime, ...); `supabase status` reports API `http://127.0.0.1:54321`, Studio `http://127.0.0.1:54323`, DB `127.0.0.1:54322`.
- `npm run db:reset` run twice: both exit 0 ("Applying migration 20261101000000_baseline.sql... Seeding data from supabase/seed.sql... Finished supabase db reset"). After the second: `pg_trgm` is installed in schema `extensions` and `supabase_migrations.schema_migrations` has exactly `20261101000000`.
- `NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co npm run db:reset` refuses with a message (guard still works).

### SIT-161 — .env.example, typed env, feature flags (done)

- `npm run lint`, `typecheck`, `format:check` pass; `npm run test:unit`: 8 files, 83 tests pass (schema/flags/production-origin, naming guard, bundle scanner).
- Dev server started with no `NEXT_PUBLIC_SUPABASE_*` set: failed at startup with `Invalid public environment: - NEXT_PUBLIC_SUPABASE_URL is required - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required` (http 000). With them set: http 200.
- `npm run build` with sentinel secrets (`SUPABASE_SECRET_KEY`, `TURNSTILE_SECRET_KEY`, `STRIPE_SECRET_KEY`) then `npm run check:bundle`: 29 client files scanned, none contain a server-only name or value.
- Mutations: a `"use client"` page importing `@/lib/env/server` failed the build (`server-only`); a planted secret value in `.next/static` made `check:bundle` exit 1.
- `npm run check:env`: passes on the repo (no `NEXT_PUBLIC_*` name contains SECRET, SERVICE or WEBHOOK).
- CI wiring of `check:env` / `check:bundle` is part of SIT-166 (not yet created).

### SIT-162 — Responsive app shell (done)

- `npm run lint`, `format:check`, `typecheck` pass; `npm run test:unit`: 10 files, 99 tests pass, including shell tests (landmarks, skip link first in tab order, `aria-current`, flag-gated Quotes, slots, drawer open by keyboard + Escape returns focus to trigger, link closes drawer) and axe-core runs on the shell and the open drawer (0 violations; color-contrast is covered by token tests, jsdom cannot compute it).
- Real browser (Playwright, dev server, all routes temporarily marked built, since reverted):
  - 1280px: sidebar visible, menu button hidden, all 8 links, Dashboard `aria-current`; Tab focuses "Skip to main content" first, visible; activating it moved focus to `#main-content`.
  - 375px: no horizontal scroll, sidebar hidden, header actions end at x=363; drawer opened with all 8 links and focus inside; Escape closed it and focus returned to "Open navigation".
  - 768px: sidebar visible, no menu button, no horizontal scroll, Search visible.
  - 640x400 (equals 200% zoom of 1280x800): no horizontal scroll; menu, Search, theme and account all inside the viewport.
- `GET /app` returns 200 with `Cache-Control: no-store`. Screenshots were taken locally and not committed.
- Found and fixed during the browser check: passing icon components from the server layout to the client shell errored (now icon names); `force-dynamic` is rejected by `cacheComponents` (now `connection()`).

### SIT-176 — Public and protected route tree (done)

- `npm run lint`, `format:check`, `typecheck`, `build` pass; `npm run test:unit`: 11 files, 136 tests pass (route map has a page or handler for every PRD 3.3 route, no duplicates, only the two P2 routes are flag-gated, sidebar never links to a missing page).
- `npm run smoke:routes` against `next dev` (P2 flags off): 26 routes, all as expected: 22 return 200, `/auth/callback` 307, `/app/settings` 307 to Organization, `/app/settings/integrations` and `/billing` 404.
- Same run with both P2 flags on (`--flags-on`): all 26 return 200 and the settings sub-nav links Integrations and Billing; with flags off the sub-nav shows only Organization and Members.
- Production build (`next build` + `next start`): `/`, `/privacy`, `/terms` static with `Cache-Control: s-maxage=31536000`; `/login`, `/demo`, `/app`, `/app/customers` send `private, no-cache, no-store, max-age=0, must-revalidate`. Smoke test passes again on the production server (26/26, 404s for P2 routes with flags off).
- Browser look (Playwright, 1100x560, dark theme): shell, Settings now in the sidebar, development notice, holding page rendered correctly.
- Not verified: proxy behavior on Netlify (not deployed).
- Found by the clean-checkout run: `npm run build` with no Supabase variables failed on `/app/settings/billing` because flags were read through the full public env parser. `getFeatureFlags()` now parses only the flags (2 new tests); `npm run build` with no environment variables set passes again (29/29 static pages generated), and the full suite is 11 files, 138 tests.

### SIT-157 — Repository layout, npm scripts (done)

- Layout test (`scripts/lib/layout.test.ts`, 26 dirs + 5 files from PRD 10) passes; folders without files hold `.gitkeep`.
- All 14 scripts from PRD 10.3 exist (checked by reading `package.json`). `test:db`, `test:e2e`, `demo:seed`, `demo:cleanup` print "not implemented yet ... Arrives with SIT-xxx" and exit 0.
- `rm -rf .next node_modules && npm ci && npm run check`: exit 0, all 7 steps passed (lint, format:check, typecheck, check:env, test:unit 13 files / 172 tests, build, check:bundle: 37 files, clean).
- Negative check: a file containing `(x: any)` made `npm run check` exit 1 at "lint" and stop; removed.
- `planSteps("test")` adds `test:db` as soon as a `.sql` file exists in `supabase/tests` (checked with a temporary file; removed) and `test:e2e` once a `*.spec.ts` exists in `e2e`; both covered by unit tests.
- README documents scripts, layout, and the branch/commit convention.

### SIT-166 — GitHub Actions CI skeleton (done)

Done and verified locally:

- `.github/workflows/ci.yml` (PR + push to `main`, `permissions: contents read`, concurrency cancel, 15 min timeout, no secrets or `env:` references). `npx @action-validator/cli` exits 0; parsed triggers, permissions, and 10 steps confirmed.
- Simulated CI: `git clone` of the commit into `/tmp/opsdesk-ci`, then with an empty environment (`env -i`): `npm ci`, `lint`, `format:check`, `typecheck`, `check:env`, `test:unit`, `build`, `check:bundle` all passed (exit 0).
- A lint error failing the pipeline was shown earlier through `npm run check` (SIT-157); the workflow runs the same commands as separate steps.

Verified on GitHub after the push to `main` was approved:

- Run 41351478373 on `main` (push): success, all steps green (checkout, setup-node, npm ci, Lint, Format check, Typecheck, Environment naming guard, Unit tests, Build, Client bundle secret scan). Annotations only: Node 20 deprecation notice for `actions/checkout@v4` / `actions/setup-node@v4` and an `ubuntu-latest` migration notice.
- Failing check: throwaway PR #1 with `(x: any)` failed at the Lint step (run 41351688574; every later step skipped). PR closed without merging and the branch deleted.

- **SIT-166:** approve pushing `main` to `origin` (`jakewanders/opsdesk`), then confirm the first Actions run is green; for the failing-run check, push a branch with a deliberate lint error, open a PR, confirm it fails, then close it.

### SIT-158 — Implementation plan, progress log, decisions log (done)

- `docs/IMPLEMENTATION_PLAN.md`: 17 feature rows (F01 to F17), each with files, migrations, tests, and Linear issues, plus a cross-cutting table. Rows contain planned names only and no status claims.
- `src/lib/plan.test.ts` (6 tests) passes: rows F01..F17 in order, no empty cell, an issue key per row, no completion wording in any table row. Mutations: adding "(done)" to a row failed it; blanking F05's migrations cell failed it; both reverted.
- Review against PRD section 2: a script compared every row's priority and milestone with the PRD table (0 mismatches) and every `SIT-`/`P-` key with the Requirements Traceability Matrix (only parent issues SIT-137, 141, 144, 145, 148 are absent from the matrix, as expected). It also found SIT-147 missing from the plan; added. M6 issues (SIT-151 to 155) are intentionally excluded.
- `docs/PROGRESS.md` restructured: one section per milestone M0 to M5; M1 to M5 say "Not started. No checks run."; M0 says milestone checks not yet run. `docs/DECISIONS.md` seeded with the planning decisions (API foundation in M1, seed registry extended per entity, M6 holds P2, activity mechanism M2 / UI M3, pending issues outside Linear). README links all docs.
- `npm run lint`, `format:check`, `typecheck`, `test:unit` (14 files, 192 tests) pass.

### SIT-163 — Shared state components (done)

- `npm run test:unit`: 15 files, 218 tests pass; `src/components/shared/shared-states.test.tsx` has 26 tests: skeletons (one polite status per area, blocks hidden), EmptyState, ErrorAlert (`role="alert"`, request ID from prop and from an API error body, retry), toast live region (`aria-live="polite"`, focus not moved), ConfirmDialog (focus starts on Cancel, Tab/Shift+Tab stay inside, Esc closes and returns focus to the opener, Cancel, Enter on the confirm button, Esc ignored and buttons disabled while the action runs, failure keeps the dialog open with an alert), and axe in light and dark for every component (0 violations; jsdom cannot compute color-contrast, covered by the token tests).
- A failing test caught a real bug: focus did not return to the opener after Esc (Radix only restores focus to its own Trigger); fixed in `ConfirmDialog`, test now passes.
- Real browser (Playwright, temporary scratch page since removed): dialog opened with focus on Cancel; Esc closed it and `#archive` regained focus; `notify.success` produced a toast inside an `aria-live="polite"` region and focus stayed on the button. Viewed in dark and light: alert, empty state, card/table/chart skeletons, toast, and dialog all render correctly.
- `npm run lint`, `format:check`, `typecheck` pass. Final clean-checkout run is in the commit message trail below.

### SIT-164 — Marketing landing page (done)

- `npm run lint`, `format:check`, `typecheck` pass; `npm run test:unit`: 17 files, 237 tests pass. New: `landing-page.test.tsx` (headline and subhead, landmarks, skip link first, Try Live Demo is `/demo` in header and hero, View Source Code absent without a repo URL and present with `target=_blank rel=noopener` when set, Technical Overview links to an existing on-page section, three feature articles, disclosure text, footer links to `/privacy` and `/terms`, no lorem/placeholder/testimonial text, no `$ % € £` and no digits except "SOC 2", no images, every illustration captioned "Not real data", axe in light and dark: 0 violations), `page.test.ts` (title, description, canonical, origin from `NEXT_PUBLIC_APP_URL`), `links.test.ts` (repo URL and origin parsing, `javascript:` and malformed values rejected).
- `npm run build` with no environment variables: `/`, `/privacy`, `/terms` are static (`○`).
- **Lighthouse 13.6.0** against `next start` of the production build (`http://localhost:3100/`, mobile emulation, headless Chrome, this Mac, no repo URL set): accessibility **100**, performance **100**, best-practices **100**, seo **100**; no failing weighted audits. Local measurement, not a deployed-site number.
- Real browser (Playwright): 1280px full page reviewed; 375px dark: no horizontal scroll, both Try Live Demo links point to `/demo`, no source link without the env var. A truncated "Negotiation" label in the illustration at 375px was found and fixed.
- Note: `next start` without the Supabase variables returns 500 for every route (the startup guard from SIT-161); Lighthouse needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` set.

### SIT-175 — Accessibility baseline (done)

- `npm run test:unit`: 19 files, 272 tests pass. New: `src/test/a11y-baseline.test.ts` (22 tests: six `jsx-a11y` rules each produce an ESLint **error** on a bad fixture and accessible markup produces none; the global `prefers-reduced-motion: reduce` rule sets animation-duration, animation-iteration-count, transition-duration and scroll-behavior on `*, ::before, ::after`; a global `:focus-visible` outline using `--ring`; every `ui/` primitive is classified and the interactive ones draw a focus-visible ring that is never translucent) and `src/components/shared/form-pattern.test.tsx` (13 tests: label wiring, `aria-describedby` for hint and error, `aria-invalid`, required marking, error text in words, `ErrorSummary` is `role="alert"`, takes focus on a failed submit and again after a second one, error links move focus to the field, axe 0 violations).
- Mutations, each caught by a failing test and then reverted: removing the reduced-motion `animation-duration` line; replacing the global focus outline with `outline: none`; removing the `jsx-a11y` rules from `eslint.config.mjs` (6 tests failed).
- Axe coverage from earlier issues still passes: shell and open drawer (SIT-162), landing page in light and dark (SIT-164), and every shared state component in light and dark (SIT-163).
- Real browser against the production build (Playwright): **focus indicator on every focusable element**: landing 9 of 9 (dark), shell 12 of 12 (light), using `focus({focusVisible: true})` and reading computed outline/box-shadow. **Reduced motion**: with `prefers-reduced-motion: reduce` emulated, animation-duration and transition-duration compute to 1e-05s and iteration count to 1; with no-preference the same element's transition is 0.15s. **Zoom/reflow**: landing at 640x400 (200% of 1280x800) has no horizontal scroll and the Try Live Demo, Technical Overview and theme controls are inside the viewport; shell at 320px has no horizontal scroll and its three header buttons are inside the viewport.
- Real bug found and fixed: at 320px the landing page scrolled horizontally (page width 372px) because a no-wrap tab row in the customer illustration widened an implicit grid track. Fixed with `grid-cols-1` on the landing grids; re-measured scrollWidth 320. (jsdom has no layout, so a unit test cannot catch this; it is covered by the browser check and the checklist's 320px item.)
- Added `scroll-padding-top: 4rem` so a focused element is not hidden by the sticky top bar (WCAG 2.2 2.4.11).
- Published the accessibility checklist in `docs/ARCHITECTURE.md` and a pull request template (`.github/pull_request_template.md`) that repeats it. The checklist is referenced from the Definition of Done of the 15 parent issues that own UI work (SIT-125, 127, 129, 131, 134 to 144); sub-issues inherit it through their parent's "all sub-issues done" rule.

### SIT-177 — Netlify deploy preview (PARTIAL, needs the Netlify account)

Done and verified locally (nothing is deployed):

- `netlify.toml` (build `npm run build`, Node 24, placeholder public Supabase values for deploy-preview and branch-deploy contexts only; parsed with Python `tomllib`), guarded by `src/lib/netlify-config.test.ts` (4 tests: no publish dir, Node matches `.nvmrc`, only `NEXT_PUBLIC_*` placeholders and no secret-like text, no `sitelaunch.dev`).
- `noindex` outside production: `src/proxy.ts` adds `X-Robots-Tag: noindex, nofollow` when Netlify's `CONTEXT` is not `production`; `next.config.ts` inlines `CONTEXT` at build because it is a build-time variable. `shouldNoindex` has 3 tests. Real runs of the production build + `next start`: built with `CONTEXT=deploy-preview` and run with no `CONTEXT`: `/`, `/privacy`, `/app`, `/app/customers`, `/login` all 200 with `x-robots-tag: noindex, nofollow`, `/app/settings/billing` 404 with the header; built with `CONTEXT=production` and the production `NEXT_PUBLIC_APP_URL`: 200 and no header; built with `CONTEXT=production` and the default app URL: server refuses to start (`NEXT_PUBLIC_APP_URL must be https://opsdesk.sitelaunch.dev for production deploys`, `/` returns 500); built with no `CONTEXT`: 200 and no header.
- `docs/DEPLOYMENT.md` with the exact setup steps, verification commands, and empty record fields.
- `npm run lint`, `format:check`, `typecheck`, `check:env` pass; `test:unit` 21 files, 281 tests pass.

NOT done (needs Jake): no Netlify site exists, so no build on Netlify, no preview URL, no 375px/desktop smoke on a preview, and no real `X-Robots-Tag` check on a preview.

## Waiting on Jake (SIT-177 addition)

- **SIT-177** (blocks SIT-213, 272, 273, 274): create the Netlify site from `jakewanders/opsdesk` (steps in `docs/DEPLOYMENT.md`), enable Deploy Previews, and tell Claude the site name and assigned `*.netlify.app` hostname (or grant the Netlify CLI/MCP access) so the preview can be verified. Do not attach `opsdesk.sitelaunch.dev` yet.

### SIT-165 — Privacy and terms pages (done)

- `npm run test:unit`: 22 files, 301 tests pass; `src/app/(marketing)/legal-pages.test.tsx` (20 tests) for both pages: one h1, last-updated date, h2 sections, landmarks and skip link, links home and to each other, a "still being built / will be checked" notice, metadata, no certification/compliance/"we never collect" claims, no placeholder text, no invented email or phone, axe 0 violations in light and dark; Privacy content (anonymous identity, cookies, 24 hours, fictional data, technical identifiers, "does not claim that no data is collected", optional analytics, kept until archived or deleted); Terms content (portfolio demonstration, fictional data only, no uptime guarantee, not certified for HIPAA, SOC 2, PCI DSS). Mutation: adding "We never collect any data." made the claims test fail; reverted.
- `npm run build` with no environment: `/privacy` and `/terms` are static (`○`); production server sends `Cache-Control: s-maxage=31536000` for both.
- **Lighthouse 13.6.0** (production build, mobile emulation, local machine): `/privacy` and `/terms` each accessibility **100**, best-practices **100**, SEO **100**; no failing weighted audits. Local measurements, not deployed-site numbers.
- Copy is written as design intent where behavior is not shipped yet (demo, cleanup, real accounts) and says so; it states what is true today (no analytics collected; theme stored in local storage; no contact address published yet). No contact details were invented. To be re-reviewed against shipped behavior in the release acceptance issues (SIT-149, P-22).
- The signup form link is not possible yet: `/signup` is still a holding page; SIT-179 owns it (comment left there).

### M0 interim check (all issues except SIT-177 finished)

Run on commit `HEAD` of this entry in a fresh clone with an empty environment (`git clone`, `npm ci`, `npm run check`): lint, format:check, typecheck, check:env, test:unit (22 files, 301 tests), build, check:bundle all passed. GitHub Actions on `main` is green. Exit criteria status against PRD 12 M0: `npm run build`, lint, typecheck pass: yes. Landing and app shell responsive: verified locally at 375px, 640px, 768px, 1280px (and 320px reflow). **Deployed in a preview: not yet (SIT-177 waits on a Netlify site).** M0 is therefore not complete. Linear: SIT-124 is Done; SIT-125 stays In Progress until the preview exists (its Definition of Done requires it); SIT-126 stays open for SIT-177.

## M1 — Authentication, Organizations & Public Demo

In progress. Per-issue results are below; milestone-level checks are not yet run.

### SIT-167 — profiles table, auth-user trigger, RLS (done)

- `supabase/migrations/20261101000100_profiles.sql`: `public.profiles` (named constraints, `timestamptz`, `avatar_url` must be https), `private` schema (no API role usage), reusable `private.set_updated_at()`, `private.handle_new_user()` (SECURITY DEFINER, `search_path = ''`, EXECUTE revoked from public, anon, authenticated) wired to `on_auth_user_created` on `auth.users`, grants reset then `select` and column-level `update (display_name, avatar_url)` to `authenticated`, RLS with `profiles_select_own` and `profiles_update_own`.
- `npm run db:reset` applied both migrations; `npm run test:db` (new real script, runs `supabase test db`): `supabase/tests/profiles.test.sql` **29 of 29 pass**, covering: exactly the expected columns (no email), RLS enabled, one profile for each of a real user, an anonymous user, and a real user with no email (`alice.smith`, `Demo User`, `New user`), no display name contains `@`, definer hardening (security definer, empty search_path, no EXECUTE for anon/authenticated/public, `private` schema unusable), user A sees only their own row, cannot select or update B (0 rows), can update their own `display_name` and `avatar_url`, cannot write `id`, `created_at`, `updated_at` (`42501`), `javascript:` avatar rejected (`23514`), cannot insert or delete, the `anon` role cannot read (`42501`), deleting the auth user deletes the profile.
- The test was written first and failed without the migration (4 of 30 ran, "Bad plan"). Two mistakes in my first test run were fixed: the plan count, and `updated_at` (`now()` is constant inside a transaction, so the trigger is proved by overwriting a deliberately old value).
- Mutations applied to the live local database, each made the named tests fail, then `db:reset` restored it (`Result: PASS`): select policy `using (true)`; select granted to `anon` with a policy; `update` granted on all columns; `handle_new_user` without a pinned search_path and with public EXECUTE.
- `npm run db:types` generated `src/lib/supabase/database.types.ts` from the local schema (includes `profiles`); formatted with Prettier. Docker's CLI is now found automatically by `db:start`, `db:stop`, `db:reset`, `db:types`, and `test:db` (`scripts/lib/docker-path.mjs`, 3 unit tests).
- `docs/SECURITY.md` created with the database conventions and the profiles policy table.
- `npm run lint`, `format:check`, `typecheck` pass; `npm run test:unit` 23 files, 304 tests pass.

### SIT-168 — Anonymous sign-ins and Turnstile CAPTCHA (done; hosted settings tracked in P-14)

- `supabase/config.toml`: `enable_anonymous_sign_ins = true`; `[auth.captcha]` enabled with provider `turnstile` and Cloudflare's published always-pass **dummy** secret; stack restarted (`db:stop`, `db:start`) to load it. `anonymous_users` rate limit stays at 30 per hour per IP.
- Manual probes against the real local Auth service (users in `auth.users` counted before and after): no token: `400 captcha_failed` ("no captcha_token found"), 0 users created; empty token: same; Cloudflare dummy token: 200, `is_anonymous: true`, 1 user, profile `Demo User` created by the SIT-167 trigger. With the config temporarily switched to Cloudflare's always-fail dummy secret, a non-empty token was rejected (`captcha_failed`, `invalid-input-response`), 0 users created, proving the provider verdict is consulted; the config was restored and the stack restarted.
- Automated: `npm run test:integration` (new script and config, `src/lib/supabase/anonymous-signin.integration.test.ts`): 3 of 3 pass (no token rejected and creates no user; empty token rejected; dummy token accepted, exactly one anonymous user, profile `Demo User`); the test deletes the user it creates (0 users left). `src/lib/supabase/captcha-config.test.ts` (6 unit tests): anonymous sign-ins on, CAPTCHA on with `turnstile`, secret is one of Cloudflare's three dummy secrets, a rate limit exists, and no real-looking Turnstile key (`0x4...`) appears in any tracked text file.
- `npm run test:unit`: 24 files, 310 tests pass; `lint`, `format:check`, `typecheck` pass. `npm run check` now also runs `test:integration` when a `*.integration.test.ts` exists.
- `docs/DEMO.md`: flow, fail-safe rule, keys table (dummy keys for local), hosted-project checklist, verification commands. `.env.example` carries the dummy site key.

Not part of this issue's acceptance (needs Jake): applying the hosted settings and production keys. No Cloudflare Turnstile widget or hosted Supabase project exists to configure or verify; production verification is tracked in P-14 and P-15.

### SIT-169 — Supabase SSR clients and session refresh (done)

- Added `@supabase/ssr` 0.12.7 and `@supabase/supabase-js` 2.118.0. Files in `src/lib/supabase/`: `client.ts`, `server.ts`, `create-server-client.ts`, `middleware.ts` (`updateSession`, `needsSession`), `resolve-user.ts`, `current-user.ts`, `cookie-options.ts`, `admin.ts`; `src/proxy.ts` now refreshes the session for `/app`, `/auth/*`, `/api/*` and the auth pages. ESLint `no-restricted-imports` limits the admin client to four trusted locations.
- Unit tests (`npm run test:unit`: 27 files, 344 tests pass): cookie options (Secure only for https, no Domain, SameSite Lax, path `/`), `needsSession` for 10 refreshed and 6 untouched paths, the admin import boundary through ESLint (5 forbidden paths plus a relative import fail with `no-restricted-imports`; 4 allowed paths pass), `createAdminClient` throws without the secret.
- Integration tests (`npm run test:integration`: 2 files, 15 tests pass against the local stack, 0 users left in `auth.users`): `resolveUser` returns `{ id, email: null, isAnonymous: true }` for a valid token and `null` for a tampered signature, a payload edited to claim another user, an expired HS256-signed token, garbage, no session, and an unreachable Auth service (never throws); a server client acting as user A reads exactly A's profile and none of B's through PostgREST (RLS), and as no user gets `42501`; the proxy refreshes an expired session cookie (valid refresh token) and returns a new `sb-...-auth-token` cookie with SameSite=lax, no Domain, and `cache-control: ...no-store`, and updates the request cookie; a request with no session passes through with no Set-Cookie.
- Mutations: `resolveUser` trusting the unverified payload made 7 integration tests fail; dropping the cache-header copy in `updateSession` made the refresh test fail; both reverted (15 pass).
- Real server (`next build` + `next start` against the local stack): `GET /app` with an expired session cookie returned 200 with `Set-Cookie: sb-127-auth-token=...; Path=/; SameSite=lax` and `cache-control: private, no-cache, no-store...`; without a cookie, no Set-Cookie; `/`, `/privacy`, `/terms` have `s-maxage=31536000` and 0 Set-Cookie headers. A client component importing the admin client failed the build ("server-only").
- A first integration run failed 3 tests: anonymous users have `email: ""`, which `resolveUser` returned instead of `null`; fixed (`email || null`).
- `npm run lint`, `format:check`, `typecheck`, `check:bundle` pass. Documented in `docs/ARCHITECTURE.md` and `docs/SECURITY.md`.

### SIT-170 — API envelope, request IDs, central error handler (done)

- `src/lib/api/`: `types`, `errors` (`ApiError` + 400, 401, 403, 404, 409, 413, 415, 422, 429, 500 subclasses), `envelope` (`okItem`, `okList`, `created`, `noContent`, response builders), `request-id`, `json-body`, `postgres-errors`, `to-api-error`, `log`, `handler` (`withApi`). `ErrorAlert` now uses the shared `ApiErrorBody` type. Contract written up in `docs/API.md`.
- Unit tests: 4 files, 85 tests (`npm run test:unit`: 31 files, 429 tests pass). One contract test per status through the real wrapper: 200 item, 200 list, 201, 204, 400 (invalid JSON and explicit), 401, 403, 404 (same message for missing and cross-tenant), 409, 413, 415, 422 (Zod with field errors, nested paths, business rule), 429 (`Retry-After`), 500 (generic message, request ID, nothing from the error or stack in the body, cause logged against the same ID, non-Error throws, and failure inside error conversion itself). Plus request-ID safety (unsafe IDs replaced), the data-shape guard (`okItem` rejects arrays, `okList` rejects objects), Postgres mapping with leak checks, params awaiting, and Response passthrough with base headers.
- Integration (`npm run test:integration`: 3 files, 24 tests against the local stack; 0 users and no probe function left behind): real Postgres/PostgREST errors mapped: unique 23505 to 409 `DUPLICATE`, FK 23503 to 422, check 23514 to 422, bad uuid 22P02 to 400, a signed-in user's insert without a grant 42501 to 403, `.single()` with no row PGRST116 to 404, a custom `OD429` raised in SQL keeps its message, `DEMO_QUOTA` code and `Retry-After: 60`, `OD403` keeps `DEMO_EXPIRED`, and a plain `RAISE EXCEPTION` (P0001, text containing `secret_table`) is NOT mapped.
- Mutations: letting the 500 echo the original message failed 2 tests; reverting the body-presence check failed the empty-stream regression test; both reverted.
- Real HTTP against `next start` with a temporary route (removed): every status above returned the documented envelope with `X-Request-Id` and `Cache-Control: no-store`; the 500 response contained only the generic message and the client-chosen request ID `trace-me-12345678` while the server log held the real cause under the same ID; a 429 carried `Retry-After: 30`; `23505` came back as 409 `DUPLICATE` with no constraint name.
- Real bug found by that run and fixed: a body-less `POST` returned 415 because in the Next.js runtime `request.body` is an empty stream, not `null`. Body presence is now decided from the actual bytes; the unit test now reproduces the empty-stream shape (the first version of the test used a `null` body and missed it).
- `npm run lint`, `format:check`, `typecheck`, `check:bundle` pass.

### SIT-171 — Permission matrix module (done)

- `src/lib/permissions/` (`matrix.ts`, `can.ts`, `docs.ts`, `index.ts`): roles owner/admin/member/viewer plus workspace kind real/demo; 11 actions (the 8 PRD 5.1 rows, with integrations and billing split, plus `email.send_external` and `demo.reset`); `can(role, kind, action)` returns `{ allowed: true, constraints }` or `{ allowed: false, reason }` (`ROLE_INSUFFICIENT`, `DEMO_RESTRICTED`, `NOT_APPLICABLE`, `UNKNOWN_ACTION`, `UNKNOWN_ROLE`, `UNKNOWN_KIND`); UI helpers `allowedActions` and `permissionsFor`; `assertCan` throws the 403 envelope (`DEMO_RESTRICTED` machine code for guests); `grantableRoles` and `canChangeMembership` for invitations and role changes. Referenced from `docs/API.md` and `docs/ARCHITECTURE.md`.
- `npm run test:unit`: 32 files, 537 tests pass; `src/lib/permissions/can.test.ts` has 108 tests: every cell of PRD 5.1 (9 actions x 5 columns = 45 cells, including the demo guest's constraints: own-org reads, quota-limited writes, simulated quotes, fictional-data exports, last-owner guard, no owner changes by admins) transcribed independently of the code; reset for guest vs real; guest denied invite, owner changes, billing, integrations, external email and org settings; deny-by-default for unknown roles, kinds, and actions including `toString`, `__proto__`, `constructor`, and non-string input; UI helper agreement with `can`; `assertCan` codes and messages; role granting and membership change rules; and a test that `docs/SECURITY.md`'s embedded matrix equals the generated one.
- Mutations, each caught and reverted: guest allowed `members.manage` (6 tests failed), viewer allowed to write (6 failed), lookup by `in` instead of `Object.hasOwn` so `toString` resolves (5 failed), changing a matrix cell without regenerating the doc (2 failed). Compile-time: an action added without a matrix entry, and a role removed from one rule, each fail `tsc`.
- `npm run lint`, `format:check`, `typecheck` pass.
- First attempt of the doc-sync test failed because Prettier pads table cells; the comparison now normalizes whitespace and dashes. One edit to that test silently did not apply (Prettier had reformatted the block) and was caught by re-running before the check.

### SIT-178 — Organizations and memberships tables (done)

- Migration `20261101000200_organizations_memberships.sql`: `public.organizations`, `public.memberships`, constraints (name/slug/industry length, slug format, IANA timezone, USD currency, kind/expiry rules, role values), indexes, deferred last-owner guard, RLS on and all API-role privileges revoked.
- `npm run test:db`: 3 files, 99 tests, `Result: PASS` (organizations 58, last-owner-guard 12, profiles 29).
- Mutations caught and reverted by `db:reset`: dropping the guard trigger failed 4/12 guard tests; dropping the slug-format constraint failed 1/58.
- First test layout aborted because `set constraints all immediate` fires every pending check; the guard tests moved to their own file with no owner-less fixtures.
- `npm run db:types` regenerated; `npm run check`: all 9 steps passed.

### SIT-187 — Hardened RLS helper functions (done)

- Migration `20261101000300_rls_helpers.sql` (6 helpers in `private`); `supabase/tests/rls-helpers.test.sql` (31 assertions: owner/admin/member/viewer, non-member, anonymous guest, live and expired demo, no JWT, malformed claim, recursion probe, anon/PUBLIC privileges, catalog search_path guard).
- `npm run test:db`: 4 files, 130 tests, `Result: PASS`.
- Mutations caught and reverted by `db:reset`: `org_is_writable` always true failed 3/31; dropping `search_path` on `has_role` plus granting `is_member` to anon failed 2/31.
- profiles test updated: `authenticated` now has USAGE on `private` by design (see DECISIONS).

### SIT-181 — Mutation request protections (done)

- `src/lib/api/request-guard.ts` (Origin / `Sec-Fetch-Site` CSRF check, trusted origins from env, Content-Length and streamed body caps), `withApi` options (`auth`, `maxBodyBytes`, `skipOriginCheck`), `readJson` now size-capped, `DEPLOY_PRIME_URL` added to server env and inlined in `next.config.ts`.
- Tests: `request-guard.test.ts` and `handler-protection.test.ts` cover forged, `null` and missing Origin, spoofed `X-Forwarded-Host`/`Host`, cross-site fetch metadata, same-origin success, 401 after origin check, 413 before parse (declared and streamed), raised per-route cap, 415.
- `npm run check`: all 9 steps passed (unit: 34 files, 568 tests; integration: 3 files, 24 tests).
- Mutations caught and reverted: origin check removed (9 failed), missing Origin accepted (4), Content-Length cap off (2), stream cap off (3), cross-site ignored (1).
- Found while testing: awaiting `reader.cancel()` on a cloned body hangs until the other tee branch is cancelled; the 415 check now does not await it.
- Not tested over real HTTP yet: no `/api/v1` route exists; the first route (health, SIT-186) should get a `next start` curl check.

### SIT-182 — Zod validation utilities and query parsing (done)

- `src/lib/validation/` (`text`, `primitives`, `query`, `body`, `paginate`): bounded plain-text schemas, uuid, calendar-checked `YYYY-MM-DD`, bounded integer cents, email, URL with scheme allowlist, tags, `listQuery`/`parseQuery`, `parseBody`, `paginate`. Rules documented in `docs/API.md`; decisions logged.
- `validation.test.ts`: 50 tests (Unicode scripts and emoji, NFC, code-point lengths, control/bidi characters, 9 HTML/script injection strings, plain `<` allowed, bad URL schemes and credentials, impossible dates, float/NaN cents, unknown sort fields including `__proto__`, `limit` 101 rejected, repeated and unknown params, 422 field paths).
- `npm run check`: all 9 steps passed (unit: 35 files, 618 tests; integration: 3 files, 24 tests).
- Mutations caught and reverted: limit cap off (2 failed), HTML check off (6), UTF-16 length (1), URL credentials allowed (1), month and day calendar checks both off (1), non-strict query object (1). Removing only one of the two redundant calendar checks is not caught, as expected (either alone is sufficient). The sort-whitelist mutation did not compile, so it was not run; that rule is covered by the tests asserting the error for 8 hostile `sort` values.
- Fixed while testing: the tag detector first allowed whitespace after `<`, which wrongly rejected "Revenue < Costs"; and `String.prototype.trim` strips a leading BOM, so only an interior BOM is rejected.

### SIT-179 — Sign-up, login and logout flows (done)

- Real flows via server actions (`src/lib/auth/`), `AuthForm` + `TurnstileField` (`src/components/auth/`), `/login` and `/signup` pages, `/auth/callback` code exchange, account-menu sign-out, app layout shows the signed-in email. Local Supabase now requires email confirmation and 8-character passwords.
- **Real browser run (Playwright, `next start` on :3100 against local Supabase):** empty submit shows an error summary with focus; sign-up shows "Check your email"; the link from the local Mailpit inbox lands on `/app` signed in; the account menu shows the email; Sign out returns to `/login`; wrong password for an existing email and an unknown email both show "The email or password is not correct."; sign-up with the existing address shows the same "Check your email"; `?next=/app/customers` lands on `/app/customers`; `next` of `//evil.example`, `https://evil.example`, `/\\evil.example` and `/app/../login` all land on `/app`; `/auth/callback?code=bad` is a 303 to `/login?error=callback`. The Turnstile widget rendered "Success!" with Cloudflare's test site key.
- `npm run check`: all 9 steps passed (unit: 38 files, 652 tests; integration: 4 files, 31 tests).
- New tests: `auth.test.ts` (safe redirect, schemas, error mapping, flows), `auth-form.test.tsx` and `turnstile-field.test.tsx` (13 tests: validation, focus, generic error, double-submit lock, check-email state, keyboard order, axe on three states), `auth.integration.test.ts` (7 tests against local GoTrue: unconfirmed, confirmed, wrong vs unknown identical, CAPTCHA required, short password).
- Mutations caught and reverted: outside-`/app` allowed (1 failed), existing account revealed (1), login sends no CAPTCHA (1), no pending lock (3), short passwords allowed (1), unknown email distinguishable (2). Removing only the `startsWith("//")` guard is not caught because the URL-origin check also rejects it (redundant defence).
- Found while testing: Next prerendered the callback route handler at build and failed without env; it now reads the request before touching env. A second sign-up for one address within `max_frequency` returns 429, so the integration test waits 1.5 s.
- Not done here (see DECISIONS): the no-organization redirect (SIT-193/209).

### SIT-180 — Route protection (done)

- `src/lib/auth/route-guard.ts` (`decideRoute`), `workspace-state.ts` (`resolveWorkspaceState`), wired into `src/proxy.ts` with session cookies carried onto redirects; `safeNextPath` from SIT-179 is the shared validator. Rules and the caveat about SIT-194 are in `docs/SECURITY.md`.
- **Real HTTP (`next start` :3100, local Supabase):** `/app`, `/app/customers?stage=won&page=2`, `/app/settings/members` all 307 to `/login?next=<encoded path>`; `/login` and `/demo` 200; `/application` 404. Browser: signed-out `/app/customers` lands on login, signing in returns to `/app/customers`; signed-in `/login`, `/signup` go to `/app`; `?next=/app/tasks` goes to `/app/tasks`; `//evil.com`, `%2F%2Fevil.com`, `https://evil.com` go to `/app`; after sign out `/app` redirects to login again.
- `npm run check`: all 9 steps passed (unit: 39 files, 674 tests; integration: 5 files, 36 tests). New tests: `route-guard.test.ts` (22: every rule, 9 open-redirect payloads raw and encoded, fixpoint over 3 users x 4 states x 8 paths, resolver cases) and `workspace-state.integration.test.ts` (5, real schema with a temporary policy that is removed afterwards; verified no `zz_` policies remain).
- Mutations caught and reverted: signed-out not redirected (4 failed), guest with no workspace (1), setup loop (2), expired demo passes (1), guest bounced from login (1), expiry ignored (2).
- Not verifiable end to end yet: the org-setup and expired-demo redirects need SIT-194's policies (see DECISIONS). The proxy's cookie carry-over on redirects is exercised only by the real browser run (sign-in then redirect worked), not by a unit test.

### SIT-188 — Immutability triggers (done)

- Migration `20261101000400_immutability_triggers.sql`: `private.prevent_column_change()`, one-line `private.protect_columns(table, cols...)`, `private.protect_org_expiry()`, `private.set_demo_expiry()`; applied to `organizations`, `memberships`, `profiles`. Usage rules for later tables in `docs/SECURITY.md`.
- `supabase/tests/immutability.test.sql` (40 assertions): each protected column on each table as `authenticated` fails with `OD403`; ordinary updates still work; `updated_at` is server time; `service_role` may change `expires_at` but never `kind`/`created_by`; `set_demo_expiry` works, refuses real orgs, unknown ids and null, and is closed to API users; creator deletion still nulls `created_by`; the helper attaches in one line to a new table and fails loudly on typos.
- `npm run test:db`: 5 files, 170 tests PASS. `npm run check`: all 9 steps passed (unit 675, integration 36).
- Mutations caught and reverted by `db:reset`: org protection trigger dropped (10 failed), expiry trigger dropped (3), authenticated trusted for expiry (2), no depth rule for NULL (3), no typo guard (1), service_role revoked on `set_demo_expiry` (6).
- The earlier last-owner test that moved a membership between organizations now expects `OD403` (the immutability trigger fires before the unique constraint).

### SIT-194 — RLS policies and restrictive grants for tenancy tables (done)

- Migration `20261101000500_rls_tenancy_policies.sql`: defaults inverted (anon has nothing; new tables, sequences and functions start closed; no PUBLIC execute), policies and column grants for `profiles`, `organizations`, `memberships` with restrictive denials; policy table in `docs/SECURITY.md`. Holding page `/app/setup` added for the route guard.
- `supabase/tests/rls-tenancy.test.sql` (60 assertions): catalog tests (RLS on every public table, anon holds no table/column privilege, authenticated writes limited to approved columns, no public function for anon/PUBLIC, a table and a function created now start closed, exact policy list); behaviour tests with actors A1 owner, A2 admin, A3 member, A4 viewer, B1 (org B), guests G1/G2 and expired-demo guest G3: reads are tenant-scoped, member/viewer/foreign-owner/guest updates change 0 rows, kind/expires_at/created_by/id/slug writes are refused, no client insert/delete of organizations, no client write to memberships (also with an accidental grant), profiles own-row only, anon gets 42501 everywhere.
- `npm run test:db`: 6 files, 227 tests PASS. `npm run check`: all 9 steps passed (unit 675, integration 36). Older pgTAP files were adjusted: privileges tests in `organizations.test.sql`, and `immutability.test.sql` now disables RLS inside its rolled-back transaction because it tests triggers.
- **Real browser run (local Supabase, `next start`):** a confirmed user with no organization who signs in and opens `/app/customers` is sent to `/app/setup` ("Set up your workspace"); after a membership is inserted `/app/customers` and `/app/setup` both load. This re-verifies the org-setup rule of SIT-180 end to end; the expired-demo rule is covered by `workspace-state.integration.test.ts` against the real policies (expired demo, live demo, real org, none).
- Mutations caught and reverted by `db:reset`: org select policy dropped (11 failed), guests allowed to edit settings (2), memberships select using true (4), any member may update org (4), anon select on profiles (4), authenticated insert on organizations (2), update on kind granted (2), default privileges reopened (2), restrictive update denial dropped (2), expired demo writable (3).

### SIT-189 — Forgot-password, reset-password and auth callback (done)

- `/forgot-password` (AuthForm in `forgot` mode), `/reset-password` (`ResetPasswordForm`, session required), callback `next` handling (`safeNextPath` extra exact path `/reset-password`), flows `requestPasswordReset` and `setNewPassword` (revokes other sessions), actions, new error outcomes (`same_password`, `no_session`), Supabase redirect allowlist entry in `supabase/config.toml`, DEPLOYMENT.md section "Supabase Auth URL configuration" (hosted setup not applied: needs Jake's Supabase access).
- **Manual local round trip recorded (real browser, Mailpit inbox):** unknown and known addresses both show the identical "Check your email" text; the reset email arrives; its link lands on `/reset-password` signed in; a mismatched confirmation shows an error summary; the matching new password saves and goes to `/app`; the old password then fails to sign in and the new one works; reusing the link goes to `/login?error=callback` with the notice "That link is invalid or has expired..."; `/reset-password` with no session says the link expired.
- `npm run check`: all 9 steps passed (unit: 41 files, 700 tests; integration: 5 files, 40 tests).
- New tests: callback route (7: default, recovery, in-app next, hostile `next` with spoofed Host/X-Forwarded-Host, invalid/reused/missing/empty/thrown code, no leak), flows and schemas, forgot and reset form components (axe, focus, double-submit lock, tab order), 4 integration tests against local GoTrue (same answer for known/unknown, CAPTCHA required, password changed + old rejected + other session revoked, no-session and reused-password refusals).
- Mutations caught and reverted: reset reveals unknown account (1 failed), other sessions kept (1), any path allowed (5), callback trusts next (1), no confirm check (1), password not updated (2).
- Found: Next prerendered `/forgot-password` at build (needs `connection()` because it reads runtime config); the PKCE verifier cookie must survive between request and link (clearing cookies in between breaks the flow, as it should); React resets uncontrolled fields after a failed server action, so password fields are cleared on error.

### SIT-190 — Dynamic rendering and no-store on authenticated routes, with a leak test (done, CDN check pending)

- `src/lib/http/cache-control.ts` (`PRIVATE_NO_STORE`, `isPrivateRoute`, `applyPrivateNoStore`), applied in `src/proxy.ts` to every private route including redirects and flag 404s (adds `Vary: Cookie`, never loosens Next's stricter header) and in `withApi`. Settings-index redirect moved into the proxy. PR template has the new checklist item. Details in `docs/SECURITY.md`.
- **Real HTTP before the change:** rendered pages were already `private, no-cache, no-store...`, but redirects (`/app` 307, `/auth/callback` 303) and the config redirect `/app/settings` carried no cache header; landing/legal pages were `s-maxage=31536000` as intended. The header test found the `/app/settings` redirect, now fixed.
- `npm run check`: all 9 steps passed (unit: 43 files, 716 tests; db: PASS; integration: 6 files, 47 tests). `check` now builds before the integration tests.
- New tests: `proxy.test.ts` (every protected path x signed-out/member/guest, redirects, public pages untouched, settings redirect), `dynamic-rendering.test.ts` (layouts use `connection()`, no `use cache`/static exports under `/app` and `(auth)`, API routes use `withApi`, marketing code reads no session), `cache-leak.integration.test.ts` (7 tests over a real `next start`: every route header, static pages cacheable with no cookies, 30 alternating A/B/signed-out requests plus RSC payload variants never cross users, tampered session cookie gets nothing).
- Mutations caught and reverted: proxy stops applying the policy (5 unit failures, and the real-server test failed 3 after a rebuild), helper does nothing (6), `/api` not private (4), `/app` layout loses `connection()` (1).
- **Waiting:** the acceptance item "CDN behavior verified on the deployed preview" needs a Netlify site (SIT-177, waiting on Jake). The same header and leak checks should be re-run against that preview; recorded in `docs/SECURITY.md`.

### SIT-191 — Demo-workspace database support (done)

- Migration `20261101000600_demo_workspaces.sql`: `public.demo_workspaces` (unique `user_id`, composite FK pinning `kind = 'demo'`, seed version/time, `last_reset_at`), RLS owner-read-only with restrictive write denials, trusted-only column trigger, helpers `demo_ttl`, `register_demo_workspace`, `record_demo_seed`, `begin_demo_reset` (atomic one-per-minute claim with `OD429` and retry-after). Documented in `docs/DEMO.md`, policies added to `docs/SECURITY.md`.
- `supabase/tests/demo-workspaces.test.sql` (38 assertions): one demo per identity (second registration is `23505`), real org cannot be registered, kind pinned, seed recording and validation, throttle at 59 s refused / 61 s allowed, guests read only their own row and cannot write anything (also with an accidental grant and RLS off), `anon` denied, cascade frees the identity, cleanup query uses the partial index. `rls-tenancy.test.sql` policy list updated.
- **EXPLAIN recorded** (5,000 demo orgs, 800 expired, seq scans enabled): `Index Scan using organizations_demo_expiry_idx` with `Index Cond: (expires_at < now())` (plan in `docs/DEMO.md`).
- `npm run test:db`: 7 files, 265 tests PASS. `npm run check`: all 9 steps passed (unit 716, integration 47).
- Mutations caught and reverted by `db:reset`: unique `user_id` dropped (15 failed), composite FK replaced by a plain FK (1), trusted-columns trigger dropped (1), update granted and denial dropped (2 + 2), throttle disabled (3), index dropped (2), select policy opened (14).

### SIT-192 — Demo seed registry and deterministic fixtures (done)

- Migration `20261101000700_demo_seed_registry.sql`: registry `private.demo_seeders`, `register_demo_seeder` (one call adds an entity), `demo_seed_version`, fixtures (`demo_company/person/first_name/last_name/email/phone/ts`), runner `seed_demo_workspace` (order by position, caller's transaction, demo-only, idempotent via the stored seed version), `clear_demo_seed_marker` for reset. `src/lib/demo/seed-manifest.ts`, `fixture-lint.ts` (+ test), `npm run demo:seed` (local-only). Extension steps for entity issues in `docs/DEMO.md`.
- `supabase/tests/demo-seed.test.sql` (49 assertions): banned-pattern lint of every fixture (emails `@example.com`, phones 555-01xx, 24 distinct values, no real brands or famous names), date window, registration, run order by position, idempotence (no duplicates), **two workspaces get byte-identical content (md5) with different ids**, reset-then-reseed restores the same content, real/unknown/unregistered orgs refused, failing seeder is atomic, browser roles cannot execute. `npm run demo:seed` run locally: "Seeded demo organization ..., seed version 1" (cleaned up afterwards).
- `npm run test:db`: 8 files, 314 tests PASS. `npm run check`: all 9 steps passed (unit 727, integration 47). Vitest fixture lint scans every seed migration, `supabase/seed.sql` and the manifest.
- Mutations caught and reverted by `db:reset`: phone outside reserved range (2 failed), real email domain (2), non-deterministic dates via `random()` (5), runner ignores marker (5), reversed order (2), seeder executable by authenticated (1).
- Note: no entity seeders exist yet (customers etc. arrive in M2); the framework is exercised with probe seeders registered inside the rolled-back tests. SIT-199 can now call `seed_demo_workspace`.

### SIT-199 — bootstrap_demo_workspace RPC (done)

- Migrations `20261101000800_bootstrap_demo_workspace.sql` (`public.bootstrap_demo_workspace()`, `private.demo_limits`, `private.demo_limit`) and `20261101000710_demo_ts_never_future.sql` (fix found by the tests). Security review notes in `docs/SECURITY.md`; DB types regenerated.
- `supabase/tests/bootstrap-demo.test.sql` (53 assertions): no parameters, definer with pinned search_path, EXECUTE for authenticated only, rejections (anon key, registered user, claim/row mismatch both ways, no identity) create nothing; creation (kind, name, 24 h expiry, UTC, owner-only membership, profile name, mapping, seed version, seeders ran); repeat calls return the same id/expiry with no duplicate rows; two guests get different organizations with identical content and no shared ids and see only their own through RLS; identity arguments impossible; guest cannot extend expiry or change kind; own expired demo replaced; capacity ceiling (429, existing guest unaffected, raising it admits); per-user advisory lock held after the call.
- `src/lib/demo/bootstrap.integration.test.ts` (6, real anonymous sessions through PostgREST): create then repeat, **40 simultaneous calls give one organization**, a call **queues behind another session's lock** (waited > 1.5 s, then returned the single org), two guests concurrently isolated, registered user and anon key rejected, identity arguments rejected and expiry patch refused.
- `npm run test:db`: 9 files, 368 tests PASS. `npm run check`: all 9 steps passed (unit 728, integration 53).
- Mutations: no stored-user check (5 pgTAP failures), no capacity ceiling (3), expiry ignored on repeat (6), always-new expiry (1 pgTAP + 1 integration), **no advisory lock (initially NOT caught: even 40 parallel API calls rarely overlap, so I added the lock-held assertion and a two-session blocking test; with those, removing the lock fails both)**. All reverted by `db:reset`.
- Found: `demo_ts(0, 9)` could be in the future before 09:00 database time (fixed and tested); `LEAST` cannot be schema-qualified.
- Not done here (by design): the HTTP route and Turnstile failure paths (SIT-204), per-entity quotas (SIT-200), reset (SIT-205).

### SIT-193 — Active-organization resolution (done)

- `src/lib/api/org-context.ts` (`ORG_HEADER`, `selectOrg`, `resolveOrg`, `loadMemberships`, `DemoExpiredError`, typed `OrgContext`) and `withOrgApi` in `src/lib/api/handler.ts` (verified user, org, role, session-scoped client). Convention and result table in `docs/API.md`; security notes in `docs/SECURITY.md`; decisions logged.
- Unit tests (23): header match with DB-sourced role, case/whitespace normalization, forged-tenant and unknown ids give an identical 404, hidden RLS rows never match, malformed ids 400, single membership default, several memberships 422 `ORG_SELECTION_REQUIRED`, none 404 `NO_WORKSPACE`, demo expiry (live, expired, exactly-now, null expiry fails closed, `allowExpired`), `withOrgApi` (401, 404, 422, 400, 403 `DEMO_EXPIRED`, DB error is a generic 500).
- Integration tests (7, real sessions and RLS): single membership default, forged header 404 identical to unknown, lying about identity still sees only own rows, no-membership user, multi-org choice with per-org roles (viewer/admin), live vs expired demo, malformed header never reaches the database.
- `npm run check`: all 9 steps passed (unit: 45 files, 751 tests; integration: 8 files, 60 tests).
- Mutations caught and reverted: forged header falls back to first membership, expiry not enforced, memberships read not limited to the caller (the integration test caught it: RLS shows other members' rows of the same org), role hard-coded to owner, null/boundary expiry fail-open.
- No existing route uses `withOrgApi` yet (customers, tasks and the others arrive in M2; SIT-203 builds the session endpoints), so the header convention is covered by tests, not by a live route.

### SIT-197 — pgTAP harness and cross-tenant negative tests (done)

- `supabase/tests/000-test-helpers.test.sql`: `tests` schema with deterministic identities (A/B orgs with owner, admin, member, viewer; guests g1/g2; expired demo g3; outsider), `create_fixtures()`, `act_as`/`act_as_uid`/`act_as_role`/`act_as_anon`/`act_as_service`/`reset`, one-shot `*_as` helpers, assertion helpers (`rows_changed`, `denied`, `sqlstate_of`, `visible_count`, `explain_text`), and a 31-assertion self-test. `supabase/tests/README.md` documents usage and how to write a new RLS test.
- **Reuse proved:** `rls-tenancy`, `rls-helpers`, `demo-workspaces`, `bootstrap-demo` and `immutability` were migrated off their private copies of `act_as`/`updated_rows`/`explain_text` onto `tests.*` and still pass.
- `supabase/tests/tenancy-isolation.test.sql` (47 assertions): every role of org A cannot read, update or delete in org B (organizations, memberships, profiles) and vice versa; guests cannot see each other or a real tenant and a real tenant cannot see a demo; nobody inserts, updates or deletes memberships (not even an owner or a guest joining a tenant); nobody promotes themselves or changes kind, expiry or `created_by`; anon cannot select, insert or delete on any public table; catalog guards (RLS on every table, no anon privileges, no client insert/delete/truncate, every SECURITY DEFINER function pins `search_path`, nothing executable by anon/PUBLIC) and a list that fails when a table is added without being covered.
- `npm run test:db`: 11 files, 446 tests PASS (before: 394).
- **Mutation checks (acceptance item), each reverted by `db:reset`:** memberships select opened (isolation 3 failed), any member may update org (30), delete granted on organizations (3), membership writes opened (27), update granted on kind/expires_at (16), anon select on profiles (2), RLS disabled on organizations (41), a definer function without `search_path` (1), profiles select opened (2), guests may edit settings (1), demo mapping select opened (caught by the older files: bootstrap 1, demo-workspaces 14). Every one failed the suite.
- `npm run check`: all 9 steps passed (unit: 45 files, 751 tests; db: PASS; integration: 8 files, 60 tests).

### SIT-198 — create_real_organization RPC (done)

- Migration `20261101000900_create_real_organization.sql`: `public.create_real_organization(org_name, org_industry, org_timezone)` (definer, pinned `search_path`, EXECUTE for authenticated only, no owner/org/user id parameters), per-user limit of 5 via `private.app_limits` (renamed from `demo_limits`), per-user advisory lock. Security notes in `docs/SECURITY.md`, limit rationale in `docs/DECISIONS.md`, DB types regenerated.
- `supabase/tests/create-real-org.test.sql` (56 assertions, uses the shared `tests.*` helpers): signature has exactly name/industry/timezone, anon key and guests and forged claims and no identity all rejected with nothing created, success (one org, `real`, no expiry, USD, `created_by` = caller, caller is the only member as owner, visible to the creator only), defaults, validation (1/81 characters, blank, null, 80 vs 81 emoji, markup, control characters, bare `<` allowed, industry, unknown time zone, `EST`, `posix/UTC`), limit of 5 then `OD429`, per-user not global, raising the limit, **atomic rollback when the membership insert is forced to fail**, advisory lock held.
- `src/lib/demo/create-org.integration.test.ts` (5, real sessions via PostgREST): creation visible only to the creator, guest rejected, validation `OD422` and identity arguments impossible, **12 simultaneous creations by one user produce exactly 5 organizations (7 `OD429`)**, a call queues behind another session's lock.
- `npm run test:db`: 12 files, 502 tests PASS. `npm run check`: all 9 steps passed (unit 751, integration 65).
- Mutations caught and reverted: no stored-user check (2 pgTAP), no limit (2 + 1 integration), no advisory lock (1 + 2 integration), name length unchecked (5 + 1), markup allowed (2), time zone unchecked (3 + 1), owner role changed to admin (2 + 3), `created_by` left null (6 + 1).
- Found while writing: `normalize(x, nfc)` is SQL syntax and cannot be schema-qualified.

### SIT-200 — Database-enforced demo caps with 429 mapping (done)

- Migration `20261101001000_demo_caps.sql`: `private.enforce_demo_cap()` (definer, pinned `search_path`, per-workspace advisory lock), one-line `private.attach_demo_cap(table, key[, count_filter])`, default caps as `private.app_limits` rows (customers 50, opportunities 30, tasks 75, quotes 20, activity events 300). Attach convention and the per-entity checklist in `docs/DEMO.md`; decisions logged.
- `supabase/tests/demo-caps.test.sql` (33 assertions, caps lowered via `app_limits`, probe tables): defaults, one-line attach with guards, row 4 of 3 refused with `OD429`/`DEMO_CAP`/retry-after, archived rows still count, delete frees room, other workspaces independent, **real organizations never capped (10 rows past a cap of 3)**, multi-row insert that crosses the cap fails whole, lowered and raised caps apply at once, count filter leaves essential events out, and **a refused activity event blocks its originating mutation (no row saved)**, advisory lock held.
- `src/lib/demo/demo-caps.integration.test.ts` (3, real guest and member through PostgREST): the guest hits the cap and the error maps to **HTTP 429 in the standard envelope** (code `DEMO_CAP`, message, `requestId`, `Retry-After: 60`); an insert queues behind another session holding the workspace lock; a real organization is unaffected (6 rows past a cap of 2).
- `npm run test:db`: 13 files, 535 tests PASS. `npm run check`: all 9 steps passed (unit 751, integration 68).
- Mutations caught and reverted: real orgs capped too (2 + 1 integration), off by one (5 + 1), archived rows excluded (6 + 1), wrong errcode (8 + 1), count filter ignored (5), invoker instead of definer (13 + 1), **no advisory lock (not caught at first; added a lock-held assertion and a two-session blocking test, now 1 pgTAP + 1 integration failure)**.
- No entity table exists yet; each entity issue (SIT-208, 216, 220, 222, 195/201) must call `attach_demo_cap` (listed in `docs/DEMO.md`).

### SIT-203 — Session and organization endpoints (done)

- Routes `GET /api/v1/session`, `GET`/`POST /api/v1/organizations`, `GET /api/v1/organizations/:id` (`src/app/api/v1/...`) built on `withApi`, `parseBody`, `selectOrg` and the user-scoped client (RLS applies); `src/lib/api/organizations.ts` (body schema, IANA check mirroring the database rule, workspace summaries); `docs/openapi.yaml` (implemented routes, guarded by `openapi.test.ts`); endpoint table in `docs/API.md`; decisions logged. Shared `src/test/real-server.ts` starts the production build against local Supabase with real member and guest sessions.
- **Integration over real HTTP (19 tests):** 201 creating a workspace (trimmed name, caller is owner, `private, no-store`, `X-Request-Id`), second user creates their own, 422 with `fieldErrors` (name, timezone), 422 for unknown fields (`owner_id`, `kind`) with nothing created, 403 `ACCOUNT_REQUIRED` for a guest, 401 signed out, 403 `ORIGIN_FORBIDDEN` cross-origin, 429 `ORG_LIMIT` after five; 200 lists only the caller's workspaces, 200 detail with role, 404 for another tenant's id identical to an unknown id, 404 across guest/member/guest boundaries, 400 malformed id, nobody ever lists another tenant; session 200 for a member (no demo), **guest sees `isAnonymous: true`, no email and the demo expiry (about 24 h, `secondsRemaining`)**, guest with no demo, expired demo reported with `expired: true` and 0 seconds, 401 for signed out and for a tampered cookie. Every status in the acceptance list (200, 201, 401, 403, 404, 422) is demonstrated, plus 400 and 429.
- Unit tests (14 + 3): schema, time zone rule, workspace summaries (expiry never negative, hidden RLS rows dropped), openapi/route agreement.
- `npm run check`: all 9 steps passed (unit: 47 files, 765 tests; integration: 11 files, 87 tests).
- Mutations: loose body schema (4 integration failures), `allowExpired` removed (1; first attempt silently did not apply because Prettier had reflowed the code, re-done with a regex). Removing the route's own guest check is **not** caught, by design: the database function returns the same `ACCOUNT_REQUIRED` 403, so the route check is defense in depth.
- Found: the cache-policy source test hard-coded `withApi(`; it now accepts a type argument and `withOrgApi`.

### SIT-205 — reset_demo_workspace RPC (done)

- Migration `20261101001100_reset_demo_workspace.sql`: `public.reset_demo_workspace(org_id)` (definer, pinned `search_path`, EXECUTE for authenticated only), clear-function support in the seed registry (`register_demo_seeder` gained an optional fifth parameter; `private.clear_demo_data`), throttle via `begin_demo_reset`, advisory lock. Behaviour in `docs/DEMO.md`, security notes in `docs/SECURITY.md`, decisions logged, DB types regenerated.
- `supabase/tests/reset-demo.test.sql` (40 assertions, shared `tests.*` helpers, probe seeder and clearer): rejections (anon key, no identity, registered user, forged claim, another guest's org, a real org, unknown id and null all identical not-found, own expired demo `DEMO_EXPIRED`) none of which changed any data or used a throttle slot; **after a reset a messy workspace (edited row, junk, deleted row) matches the original seed in both directions with new row ids**; organization row, `expires_at`, owner membership and user accounts unchanged; other guests and the real tenant untouched; 429 at 59 s and allowed at 61 s; **a failing seeder mid-reset leaves the guest's work intact and the throttle unused**; advisory lock held.
- `src/lib/demo/reset.integration.test.ts` (5, real guests via PostgREST): restore plus unchanged expiry plus the second reset mapped to **HTTP 429 `DEMO_RESET_THROTTLED` with Retry-After**; two simultaneous resets let exactly one through; another guest's id and an unknown id are the same not-found and change nothing; a registered user is rejected and a real organization's data is untouched; an expired demo and the anon key are refused.
- `npm run test:db`: 14 files, 575 tests PASS. `npm run check`: all 9 steps passed (unit 766, integration 92).
- Mutations caught and reverted by `db:reset`: ownership not checked (23 failed), expired demo resettable (2), no throttle (3 + 2 integration), no clearing (7 + 2), marker not cleared so no reseed (4 + 2), expiry extended (1), no advisory lock (1 pgTAP; the race test still passes because the throttle's atomic UPDATE already serializes, so the lock is a second line of defense). Not caught, as an equivalent mutant: dropping `kind = 'demo'` from the ownership join, because `demo_workspaces` can only reference demo organizations.
- Not done here: the HTTP route and confirmation UI (SIT-210); the idempotency token (not needed, see DEMO.md).

### SIT-206 — 24-hour demo expiry: write blocking, expiry response, restart (done)

- **Database:** migration `20261101001200_tenant_rls_template.sql`: `private.attach_tenant_rls(table)` (members read; owner/admin/member write only while `can_write`, i.e. the organization is writable; anon nothing). `supabase/tests/demo-expiry.test.sql` (30 assertions): live demo writes; viewer and other tenants cannot write; after `expires_at` INSERT is refused and UPDATE/DELETE change 0 rows (even the organization itself), reads still work, nothing changed; boundary (one second before: writable; exactly at `expires_at`: expired); the service role can still clean up; a guest cannot revive the demo; **a catalog test that fails for any permissive write policy on a table with `organization_id` that lacks `can_write`/`org_is_writable`**.
- **API:** `403 DEMO_EXPIRED` already comes from `withOrgApi` (SIT-193); real-HTTP checks below.
- **UI:** `DemoCountdown` banner (database expiry + server time at render + monotonic in-tab clock; polite live region only at 60/10/5/1 minute and expiry; refreshes at zero), `DemoEndedPanel` "Your demo has ended" with **Start a new demo** (server action `restartDemoAction` -> `restartDemo` -> `bootstrap_demo_workspace` with the guest's session), `/demo` shows the ended panel for a guest whose demo expired, `/app` layout shows the banner for guests. Test hooks documented in `docs/DEMO.md`.
- **Real browser run (Playwright, `next start`, local Supabase):** an expired guest opening `/app` lands on `/demo` with "Your demo has ended"; **Start a new demo** lands on `/app` with the banner "About 23h 59m left. Data is fictional and is deleted when the demo ends."; `/demo` for a live guest no longer shows the ended page. Screenshots reviewed.
- **Integration (real HTTP, 6 tests):** live guest sees the banner (about 24 h) and not the ended page; expired guest: `/app` 307 to `/demo` with `private` cache header, ended page content, no ended page for a visitor with no session, direct SDK writes refused (rename changes nothing, `expires_at` extension error, expiry still in the past). `restart.integration.test.ts` (2): expired guest gets a fresh seeded demo (new id, about 24 h, old one gone, exactly one demo); a registered user cannot use it.
- Unit/component (31): `formatRemaining`, thresholds, `bandLabel`; countdown (server clock, ignores a wrong device clock, counts down, announces only at crossings, refreshes at zero, axe); ended panel (one action, locked while pending, error shown, keyboard, axe); `restartDemo` error mapping.
- `npm run test:db`: 15 files, 605 tests PASS. `npm run check`: all 9 steps passed (unit: 50 files, 782 tests; integration: 14 files, 100 tests).
- Mutations caught and reverted: insert/update/delete policy ignoring expiry (13/4/6 failed), select policy opened (12), anon granted (caught after adding an assertion).
- Caveats: the "restart gives a working fresh demo" criterion is met for a guest whose session still exists; a brand-new visitor's entry (CAPTCHA, anonymous sign-in, bootstrap) is SIT-204. "No mutation succeeds on an expired org for each entity" is enforced by the template and the catalog test, and each entity issue must call `attach_tenant_rls`.

### SIT-207 — Two-phase expired-demo cleanup core (done)

- Migration `20261101001300_demo_cleanup.sql`: `service_role`-only functions (`cleanup_purge_expired_demos`, `cleanup_next_users`, `cleanup_user_eligible`, `cleanup_record_user`, `cleanup_enqueue_orphans`, `cleanup_queue_size`, `cleanup_purge_expired_keys`), retry queue `private.demo_cleanup_users`, safety predicate `private.cleanup_user_eligible` (anonymous, no membership, no real organization created; fail closed). `src/lib/cleanup/cleanup.ts` (core: batches, time budget, retry, counts and error codes only) and `run.ts` (admin client entry point); admin-client allowlist extended; runbook in `docs/DEMO.md`; decisions logged.
- `supabase/tests/demo-cleanup.test.sql` (45 assertions): privileges (service_role only, queue closed), the predicate for ten cases (null, unknown, active-demo guest, expired-but-present guest, registered owner, registered no-org user, eligible orphan, real-org creator, real member), batch limits and oldest-first order, expired demos only, clear functions run, mapping and memberships cascade, owners queued, live demos and real organizations untouched, no user deleted by phase 1, queue bookkeeping and retry ordering, orphan queueing with an age floor.
- `src/lib/cleanup/cleanup.integration.test.ts` (9, real Supabase, real admin client, mixed fixtures): expired demos and their guests removed, **active demo, real organization and real user untouched**, second run deletes nothing; a registered user's expired demo is removed but the account stays; a queued guest with an active demo is never deleted; batch size respected (3 expired, batch 2, two batches); **time budget respected** (injected clock, truncated, next run finishes, then idempotent); **phase-2 failure leaves a queued retry candidate (`1:unexpected_failure`), does not block phase 1, healthy guest still deleted, next run retries it**; eligibility check failure leaves the user alone; old orphan guest removed, fresh guest kept; logs hold counts and codes only.
- `npm run test:db`: 16 files, 650 tests PASS. `npm run check`: all 9 steps passed (unit 783, integration 109).
- Mutations caught and reverted: no time budget, no eligibility check, unknown eligibility treated as eligible, phase-2 failure aborting everything, batch size ignored, anonymity not required, membership check ignored, live demos purged. Not caught as equivalent mutants: dropping `kind = 'demo'` from the expired-org query (real organizations cannot carry an expiry: constraint) and ignoring the real-organization creator (the membership rule already blocks it; covered separately by a pgTAP case).
- Not done here (SIT-213): the Netlify scheduled function and `npm run demo:cleanup`. The idempotency-key purge now has its table (SIT-183).

### SIT-209 — Organization setup, workspace selector and user menu (done)

- Setup page and form (name, optional industry, time zone defaulting to the browser's, fixed USD), workspace selector in the shell, chooser page `/app/workspaces`, user menu (name, guest or member label, sign out). Proxy `choose` state for members with several workspaces and no valid selection.
- Tests: `org.test.ts` and route-guard/workspace-state additions (org/auth unit: 69 passed), `org-ui.test.tsx` (15 component tests incl. axe and keyboard), `workspace.integration.test.ts` (4 real-session tests).
- Real browser (Playwright, production build, local Supabase): signup, Mailpit confirm, redirected to setup, validation summary, create, dashboard with selector; second workspace, switch, reload persists; cleared cookie sends a multi-org user to the chooser; tampered cookie lands on the chooser with no leak.
- `npm run check`: all 9 steps passed (unit 814 tests/52 files, integration 113/16 files, pgTAP PASS).
- Mutations caught and reverted: silent default among several workspaces, cookie trusted without membership, guest reaching the database, no explicit choice required, chooser redirecting to itself.

### SIT-214 — Cleanup safety tests (done)

- `supabase/tests/demo-cleanup.test.sql` 45 -> 54 assertions: 220 expired demos drained in bounded calls (50, then 100, 100, 70 -> 0), an anonymous user who is a member of a real organization is never eligible and the real organization survives, expired idempotency keys purged and current kept (the table is created inside the rolled-back test with the agreed `expires_at` shape; SIT-183 will create the real one).
- `cleanup.integration.test.ts` 9 -> 11 tests (real Supabase, real admin client): 220 expired demos drained over bounded runs with every guest removed and an active demo untouched, then a no-op; an anonymous guest in a real organization is skipped while the expired demo is removed.
- Mutations caught and reverted: eligibility ignoring memberships (pgTAP 4 failures, integration 2), no batch limit (9 failures), delete ignoring kind and expiry (31 failures), eligibility always true (2).
- `npm run check`: all 9 steps passed (unit 814, integration 115 / 16 files, pgTAP PASS, 54 assertions in this file).
- Fixture note: users inserted directly into `auth.users` need empty-string token columns or GoTrue returns 500 on delete (`confirmation_token` NULL scan error); not a product defect.

### SIT-183 — Optimistic concurrency and idempotency helpers (done)

- Migration `20261101001400_concurrency_idempotency.sql`: `private.bump_version()` (version counter, client value ignored), `private.idempotency_keys` (RLS on, no policy, no grants), `public.idempotency_begin / complete / abandon` (SECURITY DEFINER acting as `auth.uid()`, execute for `authenticated` only). The cleanup's key purge from SIT-207 now has a real table to purge.
- `src/lib/api/concurrency.ts` (`updateIfCurrent`, `StaleEditError`, `expectedUpdatedAtField` / `expectedVersionField`), `src/lib/api/idempotency.ts` (`readIdempotencyKey`, `hashRequest`, `withIdempotency`), `src/lib/api-client/idempotency.ts` (`newIdempotencyKey`, `createSingleFlight`); `error.meta` added to the envelope; usage in `docs/API.md`; `Idempotency-Key` and `StaleEdit` in `docs/openapi.yaml`.
- `supabase/tests/idempotency.test.sql` (32 assertions): no grants, RLS with no policy, direct reads and deletes denied, anon cannot call, new / in_progress / mismatch / replay, results cannot be overwritten, per-route and per-user scope, abandon, key validation, expiry and 2-minute claim retake, version counter ignores client value.
- Unit (19 new): schemas, `StaleEditError` envelope, compare-and-set query shape, 404 vs 409, header parsing, canonical hash, replay / mismatch / in-progress / failure release, single-flight.
- `concurrency.integration.test.ts` (11, real Supabase, two real sessions): **two concurrent edits from one starting point: one wins, the other gets 409 and the winner's value is kept**, stale editor retries with the current timestamp, version table conflicts and ignores client versions, another user's record is 404, **five simultaneous requests with one key insert exactly one row**, replay returns the original result with no extra row, key reuse with a different payload refused, per-user keys, failed attempt releases the key, closed store, expired keys removed by `cleanupExpiredDemos` while current ones stay.
- `npm run check`: all 9 steps passed (unit 833 / 55 files, integration 126 / 17 files, pgTAP PASS).
- Mutations caught and reverted: update without the `updated_at` match, mismatch ignored, no abandon on failure, begin always claiming, version trusting the client, begin ignoring the user, a table grant to `authenticated` (pgTAP).

## M2 — Core CRM, Pipeline & Task Management

Not started. No checks run.

## M3 — Dashboard, Reporting Foundations & Activity

Not started. No checks run.

## M4 — Advanced Business Features (P1)

Not started. No checks run.

## M5 — Production Readiness & Public Portfolio Launch

Not started. No checks run.
