# Deployment

**Status: not deployed.** Nothing in this file claims a live site. The hostname, certificate, and DNS sections stay empty until they are verified (SIT-177, SIT-272, P-13 to P-16).

Production origin (PRD 10.2): `https://opsdesk.sitelaunch.dev`, hosted on Netlify with an externally managed `opsdesk` CNAME. `https://sitelaunch.dev` stays on Vercel; no apex, `www`, mail, or nameserver record is touched by anything in this repository.

## What the repository already provides

| Piece                          | Where                                                                                          | What it does                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build settings                 | `netlify.toml`                                                                                 | `npm run build`, Node 24 (same as `.nvmrc`). No publish directory: Netlify's automatic Next.js runtime handles it.                                                                                        |
| Preview placeholders           | `netlify.toml` (`[context.deploy-preview.environment]`, `[context.branch-deploy.environment]`) | Placeholder public Supabase values so previews start before a test project exists. Not real credentials.                                                                                                  |
| No indexing outside production | `src/proxy.ts`, `src/lib/robots.ts`, `next.config.ts`                                          | Every response from a deploy where Netlify's `CONTEXT` is not `production` carries `X-Robots-Tag: noindex, nofollow`. `CONTEXT` is a build-time variable, so `next.config.ts` inlines it into the bundle. |
| Production origin guard        | `src/lib/env/schema.ts`                                                                        | With `CONTEXT=production` the server refuses to start unless `NEXT_PUBLIC_APP_URL` is exactly `https://opsdesk.sitelaunch.dev`.                                                                           |
| Startup env check              | `src/instrumentation.ts`                                                                       | A missing or malformed required variable stops the server with a readable message.                                                                                                                        |

Verified locally (see `docs/PROGRESS.md`): a build with `CONTEXT=deploy-preview` sends `noindex` on every route even when `CONTEXT` is absent at runtime; a build with `CONTEXT=production` sends none; `CONTEXT=production` with the default `NEXT_PUBLIC_APP_URL` fails to start.

## One-time Netlify setup (needs the Netlify account owner)

1. In Netlify, add a site from Git: GitHub repository `jakewanders/opsdesk`, branch `main`. Leave the build command and publish directory to `netlify.toml` and the Next.js runtime. Do **not** add `opsdesk.sitelaunch.dev` yet (custom domain is SIT-272 and P-13).
2. Enable Deploy Previews for pull requests (Site configuration, Build and deploy, Branches and deploy contexts).
3. Environment variables (Site configuration, Environment variables). Names only here; values go in the dashboard, never in the repository:
   - Production context, set in SIT-272: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_APP_URL` (`https://opsdesk.sitelaunch.dev`), `NEXT_PUBLIC_GITHUB_REPO_URL`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `SUPABASE_SECRET_KEY`, `TURNSTILE_SECRET_KEY`.
   - Previews need nothing extra for the M0 shell: `netlify.toml` supplies placeholder public values.
4. Trigger a deploy and record the assigned hostname below.

## Records (fill in only after verifying)

- Netlify site name: _not created_
- Assigned hostname (`*.netlify.app`): _not recorded_
- Latest verified preview URL: _none_
- Custom domain, DNS provider, record, certificate: _not configured (SIT-272, P-13)_

## Verification commands (after the first deploy)

```bash
PREVIEW=https://<assigned-hostname>.netlify.app    # a deploy preview URL for the noindex check
curl -sI "$PREVIEW/" | grep -i -E "^HTTP|x-robots-tag"      # expect 200 and noindex, nofollow
curl -sI "$PREVIEW/app" | grep -i -E "^HTTP|cache-control|x-robots-tag"
curl -sI "$PREVIEW/app/settings/billing" | grep -i "^HTTP"  # expect 404 while the flag is off
npm run smoke:routes -- "$PREVIEW"                          # all PRD routes behave as expected
```

Then open the preview at 375px and at desktop width and confirm the landing page and the `/app` shell render.

## Rollback

Until a custom domain is attached there is nothing to roll back beyond removing the Netlify site. Rollback for the custom domain (only the `opsdesk` record and the Netlify domain association) is documented with SIT-272 and P-20.

## Supabase Auth URL configuration (SIT-189)

Auth emails (sign-up confirmation, password reset) link back to the app, and Supabase only redirects to allowlisted URLs. Anything else falls back to the Site URL, so a wrong entry shows up as the user landing on the home page with a `code` instead of on the right screen.

| Environment                    | Site URL                         | Redirect URLs (exact entries)                                                                                                                                        |
| ------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local (`supabase/config.toml`) | `http://localhost:3000`          | `http://localhost:3000/auth/callback`, `http://localhost:3000/auth/callback?next=/reset-password`, `http://localhost:3000/reset-password`                            |
| Production                     | `https://opsdesk.sitelaunch.dev` | `https://opsdesk.sitelaunch.dev/auth/callback`, `https://opsdesk.sitelaunch.dev/auth/callback?next=/reset-password`, `https://opsdesk.sitelaunch.dev/reset-password` |
| Preview / test project         | the deploy preview origin        | the same three paths on that origin only (tracked in SIT-274); never a wildcard                                                                                      |

Local email is delivered to the Supabase mail catcher (Mailpit; `http://127.0.0.1:54324`). Keep **Confirm email** on in hosted projects (local config has it on) and set the minimum password length to 8. Status: **not yet applied to a hosted project** (needs Jake's Supabase access; tracked with the production setup issues).

## Health check and pause recovery (SIT-186)

`GET /api/health` returns `{ "web": "ok", "database": "ok" | "unavailable" }`. It needs no session, is never cached, and is limited to 30 calls a minute per address (in process memory, so per warm instance: a guard against loops, not a security boundary). The status is 200 whenever the web app answers; the body says whether the database does, so a monitor can tell "site up, backend paused" from "site down". The database check calls `public.health_ping()` (returns `true`, reads nothing) with the publishable key and a 2.5 second timeout; any failure, timeout or odd answer is `unavailable`, with no details.

When the database is not answering, `/demo` and `/app` show "The live backend is not answering" (retry, technical overview, home, repository) instead of a half-working page; nothing is created. The landing and legal pages are static and keep working.

**Recovering from a paused Supabase project.** Free-tier projects pause after a period of inactivity. Restore the project from the Supabase dashboard (Project settings, then Restore), wait for it to report healthy, then check `/api/health` shows `database: "ok"`. Do not add a keep-alive job to avoid the pause policy.
