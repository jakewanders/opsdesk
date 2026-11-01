# OpsDesk

Multi-tenant business operations SaaS (customers, pipeline, tasks, quotes) built as an engineering portfolio project. Production origin: `https://opsdesk.sitelaunch.dev` (not yet deployed).

## Project docs

- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md): every P0 and P1 feature mapped to files, migrations, tests, and Linear issues.
- [`docs/PROGRESS.md`](docs/PROGRESS.md): real check results per issue and milestone, and what is waiting on the owner.
- [`docs/DECISIONS.md`](docs/DECISIONS.md): every deviation from the PRD and why.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): design tokens, app shell, route map.

## Setup

Requires Node 24 (see `.nvmrc`) and npm 11.

```bash
nvm use
npm ci
npm run dev        # http://localhost:3000
```

## Commands

| Command                           | Purpose                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                     | Start the dev server                                                                                         |
| `npm run build` / `start`         | Production build / serve it                                                                                  |
| `npm run lint`                    | ESLint                                                                                                       |
| `npm run format` / `format:check` | Prettier write / check                                                                                       |
| `npm run typecheck`               | `next typegen && tsc --noEmit` (strict)                                                                      |
| `npm run test:unit`               | Vitest (jsdom + Testing Library)                                                                             |
| `npm run test:coverage`           | Vitest with v8 coverage                                                                                      |
| `npm run test:db`                 | pgTAP database tests (placeholder until SIT-197)                                                             |
| `npm run test:e2e`                | Playwright end-to-end tests (placeholder until the E2E issues)                                               |
| `npm test`                        | Unit tests, plus `test:db` and `test:e2e` once their files exist                                             |
| `npm run check`                   | `lint`, `format:check`, `typecheck`, `check:env`, tests, `build`, `check:bundle`; stops at the first failure |
| `npm run check:env`               | Fails if a `NEXT_PUBLIC_*` name contains `SECRET`, `SERVICE` or `WEBHOOK`                                    |
| `npm run check:bundle`            | After a build, fails if a server-only variable name or value is in `.next/static`                            |
| `npm run smoke:routes`            | Hits every PRD route on a running server (`-- http://host:port`, `--flags-on`)                               |
| `npm run db:start` / `db:stop`    | Start/stop the local Supabase stack (needs Docker)                                                           |
| `npm run db:reset`                | Rebuild the LOCAL database from migrations and `supabase/seed.sql`                                           |
| `npm run db:types`                | Regenerate TypeScript types from the local database                                                          |
| `npm run demo:seed`               | Local demo seed (placeholder until SIT-192)                                                                  |
| `npm run demo:cleanup`            | Expired-demo cleanup (placeholder until SIT-213)                                                             |

Placeholder scripts print "not implemented yet" and exit 0 on their own. `npm run check` and `npm test` add `test:db` and `test:e2e` automatically once a `.sql` file exists in `supabase/tests/` or a `*.spec.ts` in `e2e/`, so a placeholder can never hide a real failure.

## Local Supabase

Requires Docker (or Podman) running (on macOS, Docker Desktop's `docker` is in `~/.docker/bin`; add it to your PATH if `docker` is not found), plus the project's pinned Supabase CLI (installed by `npm ci`).

```bash
npm run db:start     # Postgres, Auth, Studio. Prints local URLs and keys.
npm run db:reset     # apply supabase/migrations/* then supabase/seed.sql
npm run db:types     # write src/lib/supabase/database.types.ts from the local schema
npm run db:stop
```

- Studio: http://127.0.0.1:54323, API: http://127.0.0.1:54321, Postgres: `127.0.0.1:54322`.
- `db:reset` refuses to run if `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_DB_URL`, `DATABASE_URL` or `POSTGRES_URL` point at a non-local host, or if `--linked` / `--db-url` is passed.
- Migrations are forward-only files in `supabase/migrations/` named `<timestamp>_<name>.sql`; create one with `npx supabase migration new <name>`. Conventions are at the top of the baseline migration (uuid PKs, `timestamptz`, `bigint` cents, named constraints, RLS on every tenant table).
- pgTAP tests go in `supabase/tests/` (harness arrives with SIT-197).
- Generated types live in `src/lib/supabase/database.types.ts`; regenerate after every migration.

## Environment variables

Copy `.env.example` to `.env.local`. Variables are validated with Zod (`src/lib/env`); the server refuses to start with a readable error when a required one is missing or malformed (`src/instrumentation.ts`). Server-only values come from `src/lib/env/server.ts`, which imports `server-only`, so importing it from client code is a build error.

| Variable                                                                     | Scope  | Required | Notes                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`                                                   | public | yes      | Local stack: `http://127.0.0.1:54321`                                                                                                                     |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`                                       | public | yes      | Legacy name: `anon` key                                                                                                                                   |
| `NEXT_PUBLIC_APP_URL`                                                        | public | no       | Default `http://localhost:3000`. Must be `https://opsdesk.sitelaunch.dev` on Netlify production deploys (`CONTEXT=production`) and https unless localhost |
| `NEXT_PUBLIC_GITHUB_REPO_URL`                                                | public | no       | Source link on the marketing site                                                                                                                         |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`                                             | public | no       | Needed for the public demo (SIT-168)                                                                                                                      |
| `SUPABASE_SECRET_KEY`                                                        | server | no       | Legacy name: `service_role` key. Demo cleanup and guarded operations only                                                                                 |
| `TURNSTILE_SECRET_KEY`                                                       | server | no       | CAPTCHA verification                                                                                                                                      |
| `NEXT_PUBLIC_ENABLE_QUOTES`                                                  | flag   | no       | Default `true`                                                                                                                                            |
| `NEXT_PUBLIC_ENABLE_CSV_IMPORT`                                              | flag   | no       | Default `true`                                                                                                                                            |
| `NEXT_PUBLIC_ENABLE_BILLING`                                                 | flag   | no       | Default `false` (P2)                                                                                                                                      |
| `NEXT_PUBLIC_ENABLE_EMAIL`                                                   | flag   | no       | Default `false` (P2)                                                                                                                                      |
| `NEXT_PUBLIC_ENABLE_AI`                                                      | flag   | no       | Default `false` (P2)                                                                                                                                      |
| `NEXT_PUBLIC_ENABLE_INTEGRATIONS`                                            | flag   | no       | Default `false` (P2)                                                                                                                                      |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`, `AI_API_KEY` | server | no       | Optional P2 integrations                                                                                                                                  |

Guards: `npm run check:env` fails if any `NEXT_PUBLIC_*` name contains `SECRET`, `SERVICE` or `WEBHOOK`; `npm run check:bundle` (after `npm run build`) fails if a server-only variable name or value appears in `.next/static`. CI wiring arrives with SIT-166.

## Repository layout

Follows PRD section 10: `src/app/(marketing)`, `(auth)`, `app/`, `api/v1/`; `src/components/{ui,layout,shared}`; `src/features/*` (one folder per module); `src/lib/*` (supabase, auth, permissions, api, domain, validation, money, logger, env); `supabase/{migrations,tests,seed.sql}`; `netlify/functions`; `e2e`; `docs`. Empty folders hold a `.gitkeep` until their issue adds files. `.github/workflows/ci.yml` and `netlify.toml` arrive with SIT-166 and SIT-272.

## Workflow and conventions

- **Trunk-based:** `main` is the trunk and must stay runnable. Work in short-lived branches (or directly on `main` for a solo change) and keep each commit small enough to review as one pull request.
- **Branch names:** `<type>/<issue>-<short-slug>`, for example `feat/sit-178-tenancy-tables`. Linear's suggested branch names also work.
- **Commits:** Conventional Commits with the issue id in the subject, for example `feat(db): create tenancy tables (SIT-178)`. Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`. Do not commit `.env*` files (only `.env.example`), exports, or test credentials.
- **Before pushing:** `npm run check`.
- **GitHub repository:** `jakewanders/opsdesk` (private). The app reads its public source link from `NEXT_PUBLIC_GITHUB_REPO_URL`; nothing hard-codes it. Recommended repository settings, not applied by tooling: squash merge only, delete branch on merge, and the CI workflow as a required check once SIT-166 lands.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`: `npm ci` (Node from `.nvmrc`, npm cache), `lint`, `format:check`, `typecheck`, `check:env`, `test:unit`, `build`, then `check:bundle`. It uses no secrets and has read-only permissions. Database (pgTAP) and end-to-end jobs are marked as placeholders in the workflow and arrive with SIT-197 and the CI extension issues. To reproduce a CI run locally on a clean tree: `git clone . /tmp/opsdesk-ci && cd /tmp/opsdesk-ci && npm ci && npm run check`.
