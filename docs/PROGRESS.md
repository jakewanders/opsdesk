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
