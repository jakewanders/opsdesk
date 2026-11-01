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
