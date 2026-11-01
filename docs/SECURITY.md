# Security notes

Living document. The threat model and the full role table are finalized by the documentation issues (P-18); this file records the database security decisions as each issue lands. Policies are enforced by Postgres (RLS and grants), not only by application code, and each is covered by a pgTAP test in `supabase/tests`.

## Conventions

- **Grants:** Supabase grants every API role full access to new `public` tables by default. Every migration revokes all privileges from `public`, `anon`, and `authenticated` on its tables and grants back exactly what is needed, per table and, for updates, per column.
- **RLS:** enabled on every table in `public`. Policies are scoped `to authenticated`, and read the caller with `(select auth.uid())` so the value is evaluated once per statement.
- **Private schema:** helper and trigger functions live in `private`, which is not in the API's exposed schemas (`supabase/config.toml`) and has no usage granted to `anon` or `authenticated`.
- **Definer functions:** `SECURITY DEFINER`, `set search_path = ''`, every identifier schema-qualified, `EXECUTE` revoked from `public`, `anon`, and `authenticated` unless a specific role needs it.
- **Anonymous users:** Supabase anonymous sign-in users use the `authenticated` Postgres role. They are told apart by the `is_anonymous` claim, never by the `anon` role (which is the unauthenticated public key).

## public.profiles (SIT-167)

| Aspect               | Decision                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creation             | Only the `on_auth_user_created` trigger on `auth.users` (calls `private.handle_new_user`). No API role has insert.                                                                                              |
| Contents             | `display_name` (1 to 120 chars), `avatar_url` (null or `https://`, 2048 chars max), timestamps. The email address is never copied.                                                                              |
| Default name         | `Demo User` for anonymous users; the email local part for real users (`New user` if there is none).                                                                                                             |
| Read                 | `authenticated`, own row only (`profiles_select_own`).                                                                                                                                                          |
| Update               | `authenticated`, own row only (`profiles_update_own`), and only the `display_name` and `avatar_url` columns (column grant). `id`, `created_at`, `updated_at` cannot be written. `updated_at` is set by trigger. |
| Delete               | No API role. The row is removed by `on delete cascade` from `auth.users`.                                                                                                                                       |
| `anon` role          | No privileges at all: any select fails with `42501`.                                                                                                                                                            |
| Other members' names | Not readable here. Later issues (member lists) must add a narrowly scoped policy or a view; do not widen this one.                                                                                              |
| Tests                | `supabase/tests/profiles.test.sql` (29 assertions: structure, trigger, definer hardening, own-row access, cross-user negatives, column grants, anon, cascade).                                                  |

## Sessions and the admin client (SIT-169)

| Aspect                    | Decision                                                                                                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who is the caller         | `resolveUser` (`auth.getUser()`): Supabase Auth verifies the token. The cookie payload and `getSession()` are never trusted on the server. Forged, tampered, expired, or missing tokens resolve to signed out.                                            |
| Auth cookies              | Host-scoped, `SameSite=Lax`, `Secure` over https, not `HttpOnly` (the browser client needs them). Responses that set them carry `Cache-Control: private, no-cache, no-store` so a CDN cannot serve one user's session to another.                         |
| Static pages              | The proxy skips the session refresh for `/`, `/privacy`, `/terms`, so they never receive a Set-Cookie and stay cacheable.                                                                                                                                 |
| Admin (secret key) client | `src/lib/supabase/admin.ts`, server-only, bypasses RLS. Import allowed only from `src/features/demo/cleanup`, `src/app/api/v1/demo`, `netlify/functions`, `scripts`; lint fails elsewhere (tested). Constructing it without `SUPABASE_SECRET_KEY` throws. |

## API error handling (SIT-170)

- An unexpected failure always returns the same generic 500 message plus a request ID. The cause (name, database code, truncated message) is logged server-side against that ID; the request body, headers, and cookies are never logged.
- Database errors are mapped to fixed messages, so constraint names, table names, and values from Postgres cannot leak. A plain `RAISE EXCEPTION` (P0001) is deliberately not mapped, so its text can never be shown; only the custom `OD` SQLSTATEs carry an author-written message.
- A record that does not exist and a record in another tenant return the same 404 with the same message.
- A caller-supplied `X-Request-Id` is accepted only in a safe format; otherwise it is replaced, so it cannot forge or break log lines.
- API responses are `Cache-Control: no-store`.

## public.organizations and public.memberships (SIT-178)

- Tables are closed by default: RLS is enabled and all privileges are revoked from `anon`/`authenticated`. Policies and grants arrive with SIT-187 and SIT-188; until then only `service_role` and SECURITY DEFINER functions can touch them.
- `organizations.kind` is `real` or `demo`. A demo organization must carry `demo_expires_at`; a real one must not (check constraints), so cleanup can find expired demos by index.
- `timezone` must be an IANA zone from `pg_timezone_names` (helper `private.is_valid_timezone`, executable by `authenticated` and `service_role` only). Abbreviations such as `EST` and `posix/`/`right/` aliases are rejected.
- Last-owner guard: `private.assert_org_has_owner()` (SECURITY DEFINER, `search_path=''`, not executable by API roles) runs from deferred constraint triggers, so ownership can be handed over inside one transaction but a commit that leaves an organization ownerless fails with `OD409` / `LAST_OWNER`. Deleting a whole organization is allowed.
- `organizations.created_by` is nullable with `on delete set null`; memberships cascade with their organization or user.

## RLS helper functions (SIT-187)

All in the `private` schema (PostgREST serves only `public`): `current_user_id()`, `is_anonymous()`, `is_member(org_id)`, `has_role(org_id, roles[])`, `org_is_writable(org_id)`, `can_write(org_id)`.

- Pattern: `SECURITY DEFINER`, `search_path = ''`, fully qualified names, `STABLE`, EXECUTE revoked from PUBLIC/anon and granted to `authenticated` and `service_role` only. `authenticated` gets schema USAGE (needed to resolve functions in policies) but no CREATE and no table access.
- No helper accepts a user id, role or org kind from the caller: the actor is always `auth.uid()` and the JWT. Anonymous users are told apart by the `is_anonymous` claim (anything but the string `true` counts as not anonymous) and by the database-controlled `organizations.kind`.
- Demo expiry lives in `org_is_writable`: real orgs are always writable, demo orgs only while `expires_at > now()`. `can_write` = role owner/admin/member and writable.
- Recursion: helpers read `memberships`/`organizations` as the function owner, which bypasses RLS (the tables are not FORCE RLS), so a policy on `memberships` can call them without re-entering itself. A test proves this.
- A catalog test fails if any SECURITY DEFINER function in `public` or `private` lacks `search_path = ''`.

## Mutation request protection (SIT-181)

Applied by `withApi` (`src/lib/api/handler.ts`, `request-guard.ts`) to every route; order for a mutation: Origin check (403) → declared size cap (413) → JSON content type (415) → Supabase Auth user check (401) → handler.

- **Origin / CSRF**: any non-GET/HEAD/OPTIONS request needs an `Origin` that exactly matches a trusted origin (`ORIGIN_FORBIDDEN` 403). With no `Origin`, `Sec-Fetch-Site` must be `same-origin` or `none`; a missing header is refused, and `cross-site` is refused even if `Origin` matches. The opaque `Origin: null` is refused. `Host` and `X-Forwarded-Host` are never consulted.
- **Trusted origins** come from validated env: `NEXT_PUBLIC_APP_URL`, plus Netlify's `DEPLOY_PRIME_URL` (https only) when `CONTEXT` is `deploy-preview` or `branch-deploy`. Both are inlined at build in `next.config.ts` because Netlify does not guarantee them at runtime.
- **Body cap**: 100 KB by default (`maxBodyBytes` per route, e.g. 2 MB for the CSV import). A declared `Content-Length` over the cap is a 413 before anything is read; `readJson` also counts streamed bytes, so a chunked body with no or a false length is cut off at the cap.
- **User check**: `auth: "required"` (default) verifies the session with Supabase Auth on every request (401 when signed out) and passes `user` to the handler. `"optional"` is for flows that create the session (demo bootstrap); `"none"` for public endpoints (health).
- **Opt-out**: `skipOriginCheck: true` exists only for signature-verified webhooks (Stripe, if P2 is built).

## Sign-up, sign-in and sign-out (SIT-179)

- Forms (`/signup`, `/login`) submit to server actions (`src/lib/auth/actions.ts`) that validate with Zod and call Supabase Auth through the SSR client; the password never reaches client code after submit and is never trimmed, logged or returned (a failed submit refills only the email).
- **No account enumeration.** A wrong password and an unknown email return the same message ("The email or password is not correct."). Signing up with an address that already exists returns the same "Check your email" screen as a new address. A correct password on an unconfirmed account says to confirm the email (this reveals nothing the caller did not already know). Verified in a real browser and by `auth.integration.test.ts` against local GoTrue.
- **CAPTCHA.** Supabase checks a Turnstile token on every public auth call, so both forms render the Turnstile widget (`TurnstileField`) and send `captchaToken`. The token is single-use: a failed submit resets the widget. With no `NEXT_PUBLIC_TURNSTILE_SITE_KEY` the form says so and cannot be submitted.
- **Email confirmation** is on (`enable_confirmations = true`), with a minimum password length of 8 (72 bytes maximum, the bcrypt limit). The confirmation link points to `NEXT_PUBLIC_APP_URL + /auth/callback`, an exact allowlisted URL in `supabase/config.toml`.
- **Callback** (`/auth/callback`) exchanges the one-time `code` for a session, then redirects to a validated path. Redirects are built from the configured origin, never from `Host` or a query parameter; a bad or reused code goes to `/login?error=callback`.
- **`next` redirects** go through `safeNextPath`: only `/app` or below, no `//`, backslashes, control characters, encoded dot segments or absolute URLs; anything else lands on `/app`.
- **Sign out** is a server action behind the account menu (clears the session cookies, returns to `/login`).
- Supabase throttles repeated confirmation emails for one address (`max_frequency`); the form surfaces that as "Too many attempts. Wait a minute, then try again."

## Route protection (SIT-180)

`src/proxy.ts` runs `decideRoute` (`src/lib/auth/route-guard.ts`) after refreshing the session, and answers with a 307 whose cookies and cache headers are the refreshed session's. It only routes; handlers and RLS still authorize every request.

| Visitor                             | Path                | Result                                                                              |
| ----------------------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| Signed out                          | `/app`, `/app/*`    | `/login?next=<encoded, validated path and query>`                                   |
| Signed-in member                    | `/login`, `/signup` | validated `next`, else `/app`                                                       |
| Demo guest                          | `/login`, `/signup` | allowed (to create a real account)                                                  |
| Member, no organization             | `/app/*`            | `/app/setup` (the page ships with SIT-209; the setup path itself is not redirected) |
| Guest, no workspace or expired demo | `/app/*`            | `/demo`                                                                             |
| Anyone                              | `/demo`             | never redirected away (prevents loops)                                              |

- `next` goes through `safeNextPath` (only `/app` or below; `//`, backslashes, absolute URLs, encoded and dot-segment tricks fall back to `/app`).
- The workspace state is read with the caller's own session (`resolveWorkspaceState`). If it cannot be determined (query refused or failing) the result is `unknown` and nothing redirects. With the tenancy policies of SIT-194 in place the state is read for real: a member with no organization is sent to `/app/setup`. These rules are covered by unit tests with every state and by an integration test against the real policies.
- A fixpoint test walks every user kind, workspace state and start path and fails if any chain takes more than two redirects.

## Immutable columns (SIT-188)

- **One-line protection for any table:** `select private.protect_columns('public.customers', 'organization_id', 'created_by', 'created_at', 'id');` creates `<table>_protect_columns`, a BEFORE UPDATE trigger running `private.prevent_column_change()`. Changing a listed column raises `OD403` with detail `IMMUTABLE_COLUMN` (API: 403, code `IMMUTABLE_COLUMN`, message "This field cannot be changed."; the column name is only in the hint and never sent to clients). Writing the same value is not a change. Attaching twice is safe; a missing column fails when attaching, and a typo in a hand-written trigger fails on the first update instead of silently protecting nothing.
- A protected column may be set to NULL by a referential action (`ON DELETE SET NULL`, which runs as a nested trigger), so deleting a creator's account still works. A client UPDATE cannot null it.
- Applied now: `organizations` (`id`, `created_at`, `created_by`, `kind`), `memberships` (`organization_id`, `user_id`, `joined_at`), `profiles` (`id`, `created_at`). **Every later tenant table must call `protect_columns` for `organization_id`, `created_by`, `created_at`, `id`.**
- **`organizations.expires_at`** can be changed only when the running role is `postgres`, `supabase_admin` or `service_role`: that covers SECURITY DEFINER functions (they run as their owner) and trusted server code with the service key. An API user (`authenticated`, `anon`) cannot, including a demo owner for their own workspace. The named path is `private.set_demo_expiry(org_id, ts)`: demo organizations only, null refused, EXECUTE for `service_role` only; the bootstrap and reset RPCs (SIT-199, SIT-205) call it from definer code. `kind` cannot be changed by anyone through SQL UPDATE.
- `updated_at` is set by `private.set_updated_at()` on every update, so a client-supplied value is overwritten with server time.
- Triggers are SECURITY INVOKER so `current_user` is the role that ran the UPDATE. Disabling them needs table ownership, which no API role has.

## RLS policies and grants for the tenancy tables (SIT-194)

This is the template every business table copies.

**Defaults are inverted.** Migration `20261101000500_rls_tenancy_policies.sql` revokes everything from `anon`, revokes `authenticated`'s table grants, and changes the default privileges of the migration role so that _new_ tables, sequences and functions in `public` start with no access for `anon`/`authenticated` (and functions are not executable by PUBLIC). Every new table or RPC therefore needs explicit `grant`s; an RPC must `grant execute ... to authenticated`.

| Table           | Who      | select                                        | insert           | update                                                                                    | delete                  |
| --------------- | -------- | --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `profiles`      | the user | own row                                       | no               | own row: `display_name`, `avatar_url`                                                     | no                      |
| `organizations` | member   | own organizations (including an expired demo) | no (checked RPC) | owner/admin of a **real** org with writable settings: `name`, `industry`, `timezone` only | no (privileged cleanup) |
| `memberships`   | member   | memberships of own organizations              | no               | no                                                                                        | no (validated RPCs, M4) |
| any             | `anon`   | no                                            | no               | no                                                                                        | no                      |

- Policies: `profiles_select_own`, `profiles_update_own`, `organizations_select_member`, `organizations_update_admin`, `organizations_no_insert`, `organizations_no_delete`, `memberships_select_same_org`, `memberships_no_insert/update/delete`, `demo_workspaces_select_owner`, `demo_workspaces_no_insert/update/delete`. The `no_*` policies are RESTRICTIVE denials: even a future careless `grant insert` cannot open the table (tested).
- Policies call only the `private` helpers (`is_member`, `has_role`, `org_is_writable`, `is_anonymous`), which read as the function owner, so `memberships` policies do not recurse.
- A demo guest cannot edit organization settings (PRD 5.1: guests are denied `org.settings.update`), even on their own live demo; this is enforced as `not private.is_anonymous()` in the update policy. An expired demo is read-only for everyone.
- `kind`, `expires_at`, `created_by`, `id` and `slug` have no column grant, so a client cannot write them at all; the immutability triggers (SIT-188) refuse them even for a role that were granted.
- **`FORCE ROW LEVEL SECURITY` is not used.** The table owner (`postgres`) runs the SECURITY DEFINER helpers and RPCs that must cross tenants and has BYPASSRLS regardless; API roles are never owners, so RLS always applies to them.
- **Catalog tests** (`rls-tenancy.test.sql`) fail if any `public` table lacks RLS, if `anon` holds any table or column privilege, if `authenticated` holds insert/delete/truncate/references/trigger anywhere or can update any column other than the approved ones, if any `public` function is executable by anon/PUBLIC, if a freshly created table or function is not closed, or if the set of policies differs from this document.

## Password reset and the auth callback (SIT-189)

- **Request** (`/forgot-password`): a server action sends `resetPasswordForEmail` with the Turnstile token and `redirectTo = NEXT_PUBLIC_APP_URL + /auth/callback?next=/reset-password`. The response is the same neutral "Check your email" for an existing and an unknown address (verified in a real browser and in `auth.integration.test.ts`); only CAPTCHA, rate-limit and outage failures are reported.
- **Callback** (`/auth/callback`, used by sign-up confirmation and recovery): exchanges the one-time code, then redirects to a path validated by `safeNextPath`: `/app` or below, plus exactly `/reset-password` (named by the callback only). Redirects are built from the configured app origin, never from `Host`, `X-Forwarded-Host` or a query parameter. A missing, empty, reused or expired code, or a thrown error, goes to `/login?error=callback` with a friendly notice; no internals are returned.
- **Reset** (`/reset-password`): needs a signed-in session (verified with Supabase Auth); without one it explains the link expired and links to a new request. The new password gets the same rules as sign-up plus a matching confirmation. After a successful update the other sessions are signed out (`signOut({ scope: "others" })`), so an old device or a stolen session does not survive; a failure to revoke does not undo the reset. Supabase also rejects reusing the current password.
- Recovery links work once and expire after an hour (Supabase default).

## Caching of authenticated responses (SIT-190)

- **One policy, `Cache-Control: private, no-store`** (`src/lib/http/cache-control.ts`), for every response that can depend on a session: `/app` and `/app/*`, `/demo`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/*`, and `/api/*`. `src/proxy.ts` applies it to all of them, **including redirects and the flag-disabled 404s**, adds `Vary: Cookie`, and never loosens a stricter header Next.js already set (rendered pages get `private, no-cache, no-store, max-age=0, must-revalidate`). `withApi` sets it on every API response, so a new route cannot forget. The list of private routes is the same function that decides which routes refresh the session (`isPrivateRoute`).
- **Dynamic rendering.** `connection()` in the `/app` and `(auth)` layouts opts those trees into request-time rendering (`export const dynamic = "force-dynamic"` is not allowed with `cacheComponents`). A source test fails if either layout loses it, if any page there uses `"use cache"`, `revalidate`, `dynamic = ...` or `generateStaticParams`, if an API route is not wrapped in `withApi`, or if marketing code reads cookies, headers, Supabase or the user.
- **Static pages** (`/`, `/privacy`, `/terms`) stay cacheable (`s-maxage=31536000`), carry no `Set-Cookie`, and never contain the visitor's identity (tested with a signed-in visitor).
- **The settings index redirect** (`/app/settings`) moved from `next.config.ts` to the proxy, because a config redirect answered without the private headers (found by the real-HTTP header test).
- **Tests.** `src/proxy.test.ts` iterates every protected route for signed-out, member and guest. `src/test/cache-leak.integration.test.ts` starts the production build against local Supabase and checks the same headers over real HTTP, then alternates requests from user A, user B and a signed-out visitor to `/app/setup` six times (HTML and RSC payload variants) asserting each only ever sees their own email, and that a tampered session cookie gets nothing.
- **CDN (Netlify).** The app sets no `Netlify-CDN-Cache-Control` / `CDN-Cache-Control` on private routes, and `private, no-store` stops Netlify's CDN and any shared cache from storing them. `netlify.toml` defines no caching headers or edge rules. **Not yet verified on a deployed preview**: the same header test must be re-run against the Netlify preview once SIT-177 has a site (tracked there and in SIT-272).

## Permission matrix (SIT-171)

`src/lib/permissions` encodes PRD 5.1 once (`matrix.ts`); `can(role, kind, action)`, the UI helpers (`allowedActions`, `permissionsFor`), `assertCan` for route handlers, and the membership rules (`grantableRoles`, `canChangeMembership`) are all derived from it. The database (RLS) remains the final authority and must agree; hiding a control in the UI is cosmetic only. An unknown role, workspace kind, or action is denied. In a demo workspace the guest is the owner, and the "demo guest" column applies on top of the role. A "yes" can carry constraints that the caller and the database must still honor.

<!-- permissions-matrix:start -->

| Action                 | owner                  | admin                  | member | viewer | demo guest                   |
| ---------------------- | ---------------------- | ---------------------- | ------ | ------ | ---------------------------- |
| `records.read`         | yes                    | yes                    | yes    | yes    | yes (own_demo_org_only)      |
| `records.write`        | yes                    | yes                    | yes    | no     | yes (demo_quota_limited)     |
| `quotes.write`         | yes                    | yes                    | yes    | no     | yes (demo_simulated_only)    |
| `export.run`           | yes                    | yes                    | yes    | yes    | yes (demo_fictional_marking) |
| `org.settings.update`  | yes                    | yes                    | no     | no     | no                           |
| `members.manage`       | yes                    | yes (no_owner_changes) | no     | no     | no                           |
| `members.owner_change` | yes (last_owner_guard) | no                     | no     | no     | no                           |
| `integrations.manage`  | yes                    | no                     | no     | no     | no                           |
| `billing.manage`       | yes                    | no                     | no     | no     | no                           |
| `email.send_external`  | yes                    | yes                    | yes    | no     | no                           |
| `demo.reset`           | demo only              | no                     | no     | no     | yes                          |

<!-- permissions-matrix:end -->
