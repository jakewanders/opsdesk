# Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. It reads the repository only (`permissions: contents: read`), uses **no secrets** and no hosted address, and starts nothing outside the runner. `src/lib/ci-workflow.test.ts` checks those properties from the file itself (read-only scopes, no `secrets.` reference, no `*.supabase.co` / `sitelaunch.dev` / `netlify.app`, no `pull_request_target`, every action pinned to a version tag).

## Jobs

| Job (the name GitHub shows)               | What it runs                                                                                                                                                                                                                                           | Needs                                   |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `Lint, types, unit tests, build`          | lint, format check, typecheck, environment-name guard, unit tests, production build, client-bundle secret scan                                                                                                                                         | nothing                                 |
| `Database, RLS and API integration tests` | `npm run db:start` (a throwaway local Supabase stack in Docker), `npm run test:db` (pgTAP), `npm run build`, `npm run test:integration`                                                                                                                | Docker (present on `ubuntu-latest`)     |
| `Browser end-to-end tests (Playwright)`   | `npm run test:e2e`: builds the production app and runs the whole Playwright suite (desktop and phone) against a throwaway local Supabase stack started in the job; scans the server log for leaks; keeps traces and the log of a failed run for 7 days | Docker; Chromium (installed by the job) |

The database job starts its own stack, so the keys the tests use are the disposable keys the local CLI prints for that stack. There is no production credential anywhere in the workflow, and `localSupabase()` (used by every integration test) refuses any host but `127.0.0.1` or `localhost`.

## Required checks (branch protection)

Branch protection is a repository setting only Jake can change. When it is set, require both jobs: **`Lint, types, unit tests, build`** and **`Database, RLS and API integration tests`**. Add the third job, **Browser end-to-end tests (Playwright)**, once it has run green on `main`.

## What a broken policy does

Weakening a policy, a grant or a definer function fails a pgTAP file in `test:db` (the mutation runs in `docs/SECURITY.md` list which assertion catches each one) or an HTTP matrix test in `test:integration`, so the database job goes red and the pull request cannot be merged once the job is required.

## Secrets

CI needs none. Tests that would need a hosted project (the E2E job against a preview) must take their credentials from GitHub Actions **secrets** of a **separate test project**, never from the repository and never from production; that arrives with P-12.
