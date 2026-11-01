# Progress log

Real command output only. Nothing here is a claim of completion until the checks listed under it have been run; a milestone section holds its milestone-level check results once its last issue is finished. Per-issue entries are added in the order issues are finished. Pending issues that Linear could not hold (`P-01` to `P-23`, see the Pending Issues document) are tracked here by their key when worked.

## Waiting on Jake

Items only Jake can unblock. Each is also an action item in the tracker.

- **SIT-160** (local Supabase; blocks SIT-167, 168, 169, 197, so the whole database lane): install Docker Desktop or Podman, then run `npm run db:start && npm run db:reset && npm run db:reset`.
- **SIT-166** (CI; blocks SIT-177): approve pushing `main` to `origin` (`jakewanders/opsdesk`), confirm the first Actions run is green, then push a branch with a deliberate lint error, open a PR, confirm CI fails, and close it.

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

### SIT-160 — Local Supabase, migrations, seed (PARTIAL, blocked on Docker)

Done and verified without Docker:

- `npx supabase init` committed `supabase/config.toml` (CLI 2.122.0); `supabase/migrations/20261101000000_baseline.sql`, `supabase/seed.sql`, `supabase/tests/`.
- Baseline migration and seed applied twice in a row to an in-process Postgres (PGlite, scratch copy, not a project dependency): both passes succeeded, `pg_trgm` installed in schema `extensions`, `gen_random_uuid()` available. This is a syntax and idempotence check only, not a Supabase run.
- `npm run db:reset` guard: `NEXT_PUBLIC_SUPABASE_URL=https://abcd.supabase.co` exits 1 with a refusal; `--linked` exits 1; 7 unit tests in `scripts/lib/assert-local-db.test.ts` pass.
- README documents the local steps and type generation.

NOT verified: `supabase start` and a real `db:reset` (no Docker or Podman installed on this machine: `docker: command not found`).

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

### SIT-166 — GitHub Actions CI skeleton (PARTIAL, needs a push)

Done and verified locally:

- `.github/workflows/ci.yml` (PR + push to `main`, `permissions: contents read`, concurrency cancel, 15 min timeout, no secrets or `env:` references). `npx @action-validator/cli` exits 0; parsed triggers, permissions, and 10 steps confirmed.
- Simulated CI: `git clone` of the commit into `/tmp/opsdesk-ci`, then with an empty environment (`env -i`): `npm ci`, `lint`, `format:check`, `typecheck`, `check:env`, `test:unit`, `build`, `check:bundle` all passed (exit 0).
- A lint error failing the pipeline was shown earlier through `npm run check` (SIT-157); the workflow runs the same commands as separate steps.

NOT verified: any run on GitHub Actions (nothing has been pushed; the loop does not push).

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

## M1 — Authentication, Organizations & Public Demo

Not started. No checks run.

## M2 — Core CRM, Pipeline & Task Management

Not started. No checks run.

## M3 — Dashboard, Reporting Foundations & Activity

Not started. No checks run.

## M4 — Advanced Business Features (P1)

Not started. No checks run.

## M5 — Production Readiness & Public Portfolio Launch

Not started. No checks run.
