# Progress log

Real command results only. Updated after every issue and milestone.

## Waiting on Jake

_(see entries below; kept in sync with the bottom of this file)_

## M0 — Foundation & Application Architecture

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

## Waiting on Jake

- **SIT-160** (blocks SIT-167, SIT-168, SIT-169, SIT-197 and the whole database lane): install Docker Desktop or Podman, then run `npm run db:start && npm run db:reset && npm run db:reset` to finish the acceptance checks.

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
