# OpsDesk

Multi-tenant business operations SaaS (customers, pipeline, tasks, quotes) built as an engineering portfolio project. Production origin: `https://opsdesk.sitelaunch.dev` (not yet deployed).

## Setup

Requires Node 24 (see `.nvmrc`) and npm 11.

```bash
nvm use
npm ci
npm run dev        # http://localhost:3000
```

## Commands

| Command                           | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm run dev`                     | Start the dev server                                               |
| `npm run build`                   | Production build                                                   |
| `npm run start`                   | Serve the production build                                         |
| `npm run lint`                    | ESLint                                                             |
| `npm run typecheck`               | `next typegen && tsc --noEmit` (strict)                            |
| `npm run format` / `format:check` | Prettier write / check                                             |
| `npm run test:unit`               | Vitest (jsdom + Testing Library)                                   |
| `npm run db:start` / `db:stop`    | Start/stop the local Supabase stack (needs Docker)                 |
| `npm run db:reset`                | Rebuild the LOCAL database from migrations and `supabase/seed.sql` |
| `npm run db:types`                | Regenerate TypeScript types from the local database                |
| `npm run test:coverage`           | Vitest with v8 coverage                                            |

More scripts, Supabase local setup, and the env table are added by later issues.

## Local Supabase

Requires Docker (or Podman) running, plus the project's pinned Supabase CLI (installed by `npm ci`).

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
