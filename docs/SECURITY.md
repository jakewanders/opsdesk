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

## bootstrap_demo_workspace: security review notes (SIT-199)

`public.bootstrap_demo_workspace()` (migration `20261101000800_bootstrap_demo_workspace.sql`) is the one place a visitor causes data to be created in the demo, so it is reviewed like an authentication boundary.

- **Exposure.** It lives in `public` because PostgREST serves only that schema and the server route (SIT-204) calls it with the caller's own session. `EXECUTE` is granted to `authenticated` (and `service_role`) only; `anon` and PUBLIC cannot call it (tested; the catalog test also fails if any `public` function is executable by anon/PUBLIC). Everything that matters is checked inside the function, not by the route.
- **No caller-controlled inputs.** It takes no parameters (`pronargs = 0`; calling it with an owner or organization id is a "function does not exist" error, verified through PostgREST). Owner = `auth.uid()`; organization id, `kind = 'demo'`, name, time zone and `expires_at = now() + 24 hours` are chosen by the function, and the guest cannot change `expires_at` or `kind` afterwards (column grants plus the immutability triggers).
- **Anonymous only, double-checked.** The signed JWT claim (`private.is_anonymous()`) **and** the stored `auth.users.is_anonymous` must both be true. A registered user, a registered user with a forged claim, an anonymous user with a claim of `false`, and a call with no identity are all rejected with `OD403` (`GUEST_ONLY` / `NOT_SIGNED_IN`) and create nothing.
- **Idempotent and race safe.** A per-user transaction advisory lock (`pg_advisory_xact_lock(hashtextextended('opsdesk.demo.bootstrap:' || uid))`) serializes that user's calls; the unique `demo_workspaces.user_id` is the backstop. A repeat call returns the same organization with the same expiry (calling again never extends it) and adds no rows. Proved with pgTAP (lock held after the call) and a real two-session test (a call waits while another session holds the user's lock, then returns the single organization); 40 simultaneous API calls produce one organization.
- **Expired demo.** A caller whose own demo expired has it deleted (cascade: mapping, memberships, and later every entity row through its foreign key) and receives a fresh one. Only the caller's own organization can be touched: the id comes from the caller's mapping row, never from input.
- **Capacity.** If the number of unexpired demos is at `private.app_limits.max_active_demos` (default 200; no client access) a new guest gets `OD429 DEMO_CAPACITY` (retry-after 300 s). A guest who already has a live demo is unaffected at capacity.
- **Isolation.** Two guests get separate organizations and separate record ids with identical seed content; each sees only their own organization, membership and mapping through RLS (tested in SQL and over the API).
- **Residual risks / notes.** (1) The deployment's anonymous sign-in rate limits and Turnstile (SIT-168, SIT-204) are what stop mass creation of guests; the ceiling only bounds the damage. (2) The idempotency token from the API layer (SIT-183) is not used: the function is idempotent by construction. (3) Per-entity quotas arrive with SIT-200.

## Active organization resolution (SIT-193)

`withOrgApi` / `resolveOrg` (`src/lib/api/org-context.ts`) choose the organization for tenant API calls from the `X-Organization-Id` header and **prove membership on every request** (convention and result table in `docs/API.md`). Properties: a forged or foreign id and an unknown id are indistinguishable (404 `ORG_NOT_FOUND`); the role is read from the caller's own membership row, never from the request; the memberships read uses the caller's session so RLS applies (a client that claims another user's identity still only sees its own rows); several memberships require an explicit choice; an expired demo is refused with a distinct `DEMO_EXPIRED`. The database remains the final authority: RLS and the RPCs check tenancy again.

## create_real_organization (SIT-198)

`public.create_real_organization(org_name, org_industry, org_timezone)` (migration `20261101000900_create_real_organization.sql`) is the only way a client creates a real organization (`organizations` has no insert grant).

- **No identity inputs.** The signature is name, industry and time zone. Owner = `auth.uid()`, `kind = 'real'`, no expiry, currency the table's fixed USD; a call that passes an owner or organization id fails (verified through PostgREST).
- **Registered users only.** The signed claim and the stored `auth.users.is_anonymous` must both say registered; a guest, a guest with a claim of `false`, a registered user with a forged anonymous claim and a call with no identity are all `OD403` (`ACCOUNT_REQUIRED` / `NOT_SIGNED_IN`) and create nothing. The guest message is the friendly "Create an account to keep your data".
- **Atomic.** The organization and the caller's `owner` membership are inserted in one transaction; a forced failure on the membership insert leaves no organization behind (tested), and the deferred last-owner guard would refuse an ownerless organization at commit anyway.
- **Validation backstop** (the API validates first, SIT-203): name 2 to 80 characters (code points), no control characters, no tag-like markup; optional industry up to 80; time zone from `private.is_valid_timezone` (IANA only; abbreviations and posix/right aliases refused). Failures are `OD422` with `INVALID_NAME` / `INVALID_INDUSTRY` / `INVALID_TIMEZONE`.
- **Abuse limit.** At most **5 real organizations per user** (`private.app_limits.max_real_orgs_per_user`, adjustable without a deploy; no client access): the sixth is `OD429 ORG_LIMIT`. A per-user advisory lock serializes a user's creations, so a burst of parallel calls cannot get past the limit (12 simultaneous API calls produced exactly 5 organizations; a call queues behind another session holding the lock).
- `private.demo_limits` was renamed `private.app_limits` (it now holds all application limits).

## Demo caps (SIT-200)

Hard caps per demo workspace are enforced by a SECURITY DEFINER `BEFORE INSERT` trigger (`private.enforce_demo_cap`, attached with `private.attach_demo_cap`): customers 50, opportunities 30, tasks 75, quotes 20, activity events 300. It reads the organization kind and counts rows as the function owner, so a caller who cannot see the organization row cannot slip past it; it counts archived rows too; real organizations are never counted; a per-workspace advisory lock makes the cap strict under concurrency; the refusal is `OD429 DEMO_CAP` (HTTP 429 in the standard envelope, `Retry-After: 60`). The limits are rows in `private.app_limits` (no client access). Details and the attach convention for entity migrations are in `docs/DEMO.md`.

## reset_demo_workspace (SIT-205)

`public.reset_demo_workspace(org_id)` (SECURITY DEFINER, pinned `search_path`, EXECUTE for `authenticated` only) is the only way data is deleted by a visitor. It requires an anonymous guest (claim and stored user) who owns the named demo through their `demo_workspaces` row; every other target (another guest's, a real organization, unknown) is one indistinguishable not-found. It never changes the organization, its membership, `expires_at` or any user account, and cannot touch another tenant: the clear functions it runs are scoped `where organization_id = org_id` and the id comes from the caller's own mapping. Resets are throttled to one per minute per workspace through an atomic `UPDATE` claim (a per-workspace advisory lock also serializes them) and the whole operation is one transaction, so a failure leaves the previous data and the throttle untouched. Behaviour and how entity issues register clear functions: `docs/DEMO.md`.

## Demo expiry (SIT-206)

Expiry is enforced by the database, not the UI: `private.org_is_writable` (strictly `expires_at > now()`) is part of `private.can_write`, which every standard tenant policy created by `private.attach_tenant_rls` requires for insert, update and delete, so an expired demo is read-only even to a client using the Supabase SDK directly; a catalog test fails if any permissive write policy on a table with `organization_id` omits it. The guest cannot extend `expires_at` (no column grant, immutability trigger). The API answers `403 DEMO_EXPIRED`, the proxy sends expired guests to `/demo`, and the UI never relies on a client clock. Details and the test hooks: `docs/DEMO.md`.

## Expired-demo cleanup (SIT-207)

Cleanup uses the admin (secret-key) client, so its scope is enforced twice. Phase 1 is SQL that deletes only `kind = 'demo'` organizations past `expires_at` (real organizations cannot have an expiry: constraint) and never touches a user. Phase 2 deletes a user through the Auth Admin API only after `private.cleanup_user_eligible` proves the user is anonymous, belongs to no organization and created no real organization; anything else, or any error while checking, leaves the account alone (fail closed). Every cleanup function is executable by `service_role` only; the retry queue has no client privileges. The module logs counts and error codes only. Runbook: `docs/DEMO.md`.

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

### Active-workspace cookie (SIT-209)

`od_active_org` stores which workspace the member last opened. It is a preference only: `resolveActiveWorkspace` ignores it unless it is a UUID naming a workspace the caller belongs to, `selectWorkspaceAction` re-checks membership before setting it, and a tampered value lands on the chooser with nothing leaked. Guests cannot create workspaces (blocked in the core and the database function).

## Server logging and redaction (SIT-185)

All server logs go through `src/lib/logger` (`logger.info/warn/error(event, fields)`, `logger.child({ requestId })`): one JSON line per event with `ts`, `level`, `event` and the fields. `console.*` is banned in application code by ESLint, because it bypasses redaction.

- **What is logged.** `withApi` writes one `api.request` line per request: `requestId`, `method`, `route` (ids become `:id`, no query string), `status`, `durationMs`, and `userId` and `orgId` when known. 5xx is `error`, 4xx `warn`, otherwise `info`. Unexpected failures add `api.unhandled_error` with the error's name, code and a redacted, truncated message (no stack). Handlers get `log` (bound to the request) and `trace({ orgId })`. Cleanup and import jobs log counts and error codes only.
- **What is never logged.** Request and response bodies, headers, cookies, query strings, e-mail addresses.
- **Redaction (`redact.ts`), applied to every field of every line.** By key, at any depth: token, secret, password, authorization, cookie, API key, credential, session, JWT, bearer, invitation, signature, captcha, nonce, `notes`, `description`, `body`, `content`, `comment`, `email`, `phone`, `address` and similar. By pattern in any string: JWTs, `Bearer` and `Basic` credentials, provider key prefixes (Supabase, Stripe, Resend, GitHub, Slack, Turnstile), connection-string passwords, `name=value` pairs with secret-looking names, e-mail addresses, and long opaque tokens (UUIDs are kept). Output is bounded (depth 6, 20 array items, 500 characters) and cycles are cut. A logging failure never breaks a request.
- **Levels.** `LOG_LEVEL` is `debug`, `info` (default), `warn`, `error` or `silent` (the unit-test setup).

## Activity events (SIT-195)

`public.activity_events` is the append-only history (PRD 6.2). Columns: `id`, `organization_id` (foreign key, cascade), `entity_type` (`customer`, `opportunity`, `task`, `quote`), `entity_id`, `action` (`created`, `updated`, `archived`, `restored`, `deleted`, `stage_changed`, `completed`, `reopened`, `sent`, `approved`, `rejected`, `imported`; extend either list with a migration), `actor_user_id` (set null when the user is deleted), `summary` (1 to 300 characters), `changes` (a JSON object, at most 4096 bytes), `created_at`. Indexes: `(organization_id, created_at desc)` and `(organization_id, entity_type, entity_id)`.

- **Read.** Members of the organization (any role, and a guest for their own demo) through one policy, `private.is_member(organization_id)`. Another organization's events, and every event for a signed-out caller, return nothing.
- **Write.** No API role holds INSERT, UPDATE, DELETE or TRUNCATE, and there is no write policy. Events are inserted by SECURITY DEFINER functions and triggers (SIT-201), which run as the table owner.
- **Defence in depth.** A SECURITY INVOKER trigger refuses every UPDATE (even for the server role) and refuses DELETE and TRUNCATE unless the running role is `postgres`, `supabase_admin` or `service_role`: the demo reset and cleanup run as the function owner, and removing an organization cascades its events. A test widens grants and policies on purpose and shows the trigger still stops a browser role.
- **`entity_id` is not a foreign key**, because an event must outlive the row it describes (entities are archived, and the cleanup deletes whole demo workspaces). The organization is a foreign key, so an organization's removal takes its events with it.
- **Demo.** The `demo_cap_activity_events` cap (300) applies to demo workspaces only (`activity_events_demo_cap` trigger); the reset clears the workspace's events through a registered clear function (`activity_events`, position 990, which seeds nothing: history comes from the entities' own seed inserts).

## Activity logging mechanism (SIT-201)

A change and its event commit together because the event is written inside the same transaction: by an `AFTER INSERT OR UPDATE` row trigger, or by the RPC that makes a named transition. A failure after the mutation, or in the event insert itself (including the demo cap), rolls both back: there is no change without its audit trail.

- **Writer.** `private.log_activity(org_id, entity_type, entity_id, action, summary, changes, occurred_at)` is SECURITY DEFINER with `search_path = ''`. Neither it nor any helper is executable by `anon`, `authenticated` or PUBLIC, and nothing is exposed in the API schema.
- **Actor.** `auth.uid()`, shown by the profile's display name. In system mode (switched on, transaction-local, by the seed runner and restored afterwards) there is no actor and the summary says `System`. `occurred_at` (to back-date seeded history) is honoured only in system mode; everyone else is stamped with the clock time.
- **Whitelist** (`private.sanitize_activity_changes`, applied to every call): `changes` ends up as `{ field: { old, new } }` for plain column names with short scalar values (strings cut to 120 characters, objects and arrays flattened to `"[complex]"`), plus `_content_changed: [field names]` for free text (notes, description, body, content, comment...), contact data (e-mail, phone, address...) and secrets (password, token, key, session, cookie...). Content and secret values are never stored; only the fact that the field changed. Keys that are not plain column names are dropped. Summaries have control characters removed and are cut at 300 characters.
- **Triggers.** `private.attach_activity_log(table, entity_type, name_column, safe_fields, content_fields, archive_column)` in the entity migration: INSERT is `created`; the archive column going from null to a value is `archived`, back to null is `restored`; a changed safe or content field is `updated` (summary `Pat Owner updated customer "Acme" (name, status)`); rewriting a value with itself, or touching only `updated_at`, writes nothing. Named transitions call `log_activity` with the PRD summary, for example `Demo User moved "Warehouse Retrofit" from Proposal to Negotiation`.
- **Demo.** The `demo_cap_activity_events` cap (300) applies to the insert, so a demo at the cap gets 429 on the next change and the change is not saved; the reset clears events and the seed's inserts are logged as System.

## Customers table: the entity pattern (SIT-208)

`public.customers` is the template every business table copies (opportunities, tasks, quotes):

- **Shape.** `unique (organization_id, id)` so children use composite foreign keys that cannot cross tenants; `assigned_to` is a composite foreign key to `memberships (organization_id, user_id)` (the assignee must belong to the same organization; removing the member clears only the assignment); `created_by` defaults to `auth.uid()`. Constraints: display name 2 to 120, company name at most 120, e-mail at most 254 and matching a basic format and stored trimmed and lower-case (a trigger normalizes before the checks), phone at most 40, website `http(s)://` only (no `javascript:` link can be stored), status `lead|active|inactive`, source `referral|website|outbound|other`, type `person|company`, 0 to 10 tags of 1 to 30 characters, notes at most 5,000. E-mail is deliberately not unique.
- **Access** (`private.attach_tenant_rls`, then narrowed): members read; owner, admin and member insert and update while the workspace is writable (an expired demo refuses writes); viewers read only; `created_by` must equal the caller (restrictive insert policy); **no DELETE grant or policy for anyone**: archive is `archived_at`.
- **Attached protections.** `id`, `organization_id`, `created_by` and `created_at` cannot change (`protect_columns`); `updated_at` is maintained; the demo cap (50, archived rows count); activity logging (safe fields: names, type, status, source, assignee; content fields logged by name only: e-mail, phone, website, notes, tags).
- **Indexes.** `(organization_id, archived_at, updated_at desc)` for the list, `(organization_id, status)`, `(organization_id, assigned_to)`, and a trigram GIN index over lower-cased name, company and e-mail for search.
- **Seed.** `private.seed_customers` (position 10) adds exactly 18 customers per demo workspace: 12 companies and 6 people from the fixture functions, `example.com` addresses, 555-01xx phones, every status and source, three archived, six assigned to the workspace owner, history logged as System. The same content in every workspace.
- **Helper exposure.** `private.valid_tags(text[])` is executable by `authenticated` because a CHECK is evaluated with the caller's privileges; it is an immutable pure function and is named in the callable-surface catalog test.

## Opportunities table (SIT-216)

`public.opportunities` follows the customers pattern (`docs/SECURITY.md#customers-table-the-entity-pattern-sit-208`): `unique (organization_id, id)`, normalization, `created_by` forced to the caller, members read and owner, admin and member write while the workspace is writable (viewers read only, an expired demo refuses writes), no DELETE (archive through `archived_at`), protected `id`, `organization_id`, `created_by` and `created_at`, `updated_at` maintained, the demo cap (30, archived rows count) and activity logging (safe: title, customer, stage, amount, probability, close date, assignee; content by name only: description, lost reason).

- **Same-tenant integrity.** `(organization_id, customer_id)` is a composite foreign key to `customers (organization_id, id)`: a deal can never point at another organization's customer, and `customer_id` is required. `assigned_to` is a composite foreign key to `memberships` (a removed member clears only the assignment). A customer that has deals cannot be deleted (customers are archived, never deleted), and archiving one keeps its deals; removing a whole organization removes both in one statement.
- **Stage rules in the database.** Stage is one of six values; `lost_reason` is required (1 to 500 characters) exactly when the stage is `lost` and absent otherwise; `closed_at` is set exactly when the stage is `won` or `lost`; amount is whole cents from 0 to 100,000,000,000; probability 0 to 100. The probability defaults from the stage (10/25/50/75/100/0, the same table as `src/lib/domain/pipeline.ts`) on insert, and a stage change that does not also change the probability resets it to the new stage's default. `closed_at` and `lost_reason` are deliberately not auto-filled: the stage-change function (SIT-227) sets them with the stage, and the checks refuse an inconsistent row.
- **Seed.** `private.seed_opportunities` (position 20) adds exactly 10 per workspace on ten different active seeded customers: 2 new, 2 qualified, 2 proposal, 1 negotiation, 2 won, 1 lost with a reason; amounts 1,000.00 to 100,000.00; close dates relative to today; identical across workspaces; history logged as System. The reset clears deals before customers.

### Extending the activity logging tests to a new entity (SIT-217)

`supabase/tests/activity-matrix.test.sql` runs the same scenario for every entity table: a create by a member, a safe-column edit by an admin, a content-only edit, no-op updates, archive then restore, a forced failure after the insert, and the System actor on seeded events; plus the shared checks that no client can insert, update or delete events or call `log_activity`, and that an oversized `changes` payload is rejected. When an entity migration attaches `private.attach_activity_log`, add ONE row to the `cases` list at the top of that file (table, entity type, a valid INSERT with `%L` for id and organization id, the safe column and its two values, the content column and its original value, the archive column) and add 13 to the plan. Trigger functions that run as the calling role must not call private helpers the API roles cannot execute: the matrix inserts as a member in a fresh session, which is what exposed such a bug in `prepare_opportunity`.

## public.invitations (SIT-196)

- **What is stored.** Only `token_hash`: the SHA-256 of a high-entropy random token, 64 lowercase hex characters (a CHECK refuses any other shape, so a plaintext token cannot be written by mistake). The plaintext is shown once to the inviter and never stored or logged. A copy of the table, a backup or a read-only SQL injection therefore cannot be turned into a way to join a workspace.
- **Who can read.** Owners and admins of the organization (`invitations_select_admin`). Members, viewers, non-members, other tenants' owners, demo guests and `anon` read nothing. The API roles hold SELECT only, so no direct insert, update or delete exists; every write is a trusted function (SIT-202).
- **What it can express.** Roles `admin`, `member` and `viewer` only (a CHECK: an owner invitation cannot exist, even if the function had a bug); lowercase, trimmed, address-shaped email (a CHECK); at most one OPEN invitation per organization and address (a partial unique index; an expired invitation stays open until the function revokes it, because an index cannot read the clock); an invitation is accepted or revoked, never both.
- **Immutable after insert:** id, organization, address, role, hash, inviter, creation time and **expiry** (the expiry cannot be extended by anyone once issued). Only `accepted_at` and `revoked_at` are written later.
- **Real workspaces only.** A trigger refuses an invitation for a demo workspace (`OD403`): a demo is one anonymous guest and can never invite anyone.
- Threats this closes: token theft from the database, privilege escalation by inviting an owner, extending a stolen invitation's life, reading another workspace's pending invitations, and a guest inviting people. Who may call the functions, the last-owner rule, redemption rate limits and verified-email matching are covered under "Membership and invitation functions (SIT-202)" below.

## Membership and invitation functions (SIT-202)

- **Callers.** `create_invitation`, `revoke_invitation`, `redeem_invitation` and `change_membership` are SECURITY DEFINER with `search_path = ''`; EXECUTE is granted to `authenticated` only (not `anon`, not PUBLIC). None takes an actor argument: the caller is always `auth.uid()`. The helpers they share (`require_registered_actor`, `actor_role_in_real_org`, `constant_time_equals`) are not callable by clients. A demo guest is refused by the stored user (`is_anonymous`), not by a JWT claim, so a forged claim does not help (`OD403`).
- **Not found, not forbidden, for outsiders.** A non-member, another workspace's owner and an unknown workspace id all get the same `OD404`, so the existence of a workspace is not revealed. A demo workspace gets `OD404` too.
- **Tokens.** The plaintext is 256 bits (two UUIDv4 values joined), returned once by `create_invitation` and never stored or logged; only its SHA-256 is stored. Redemption hashes what it is given and compares the hashes in constant time. A token in any other shape (wrong length, upper case) is `invalid` without a lookup.
- **Redemption.** Needs a confirmed email that equals the invited address (case-insensitive): `email_unverified` and `email_mismatch` refuse it, and `invalid`, `revoked`, `used` and `expired` are separate answers. Failures are returned as `{ok:false, reason}` rather than raised, so the attempt row is committed and the rate limit (10 per 15 minutes, `private.app_limits`) holds; a rolled-back attempt would let someone guess without being counted. The membership and `accepted_at` are written in one transaction, and a second use is `used`.
- **No privilege escalation.** Invitations can carry `admin`, `member` or `viewer` only. An admin cannot grant owner, cannot change or remove an owner, and cannot promote themselves (`OD403`); only an owner can.
- **Last owner.** `change_membership` locks the organization row (`FOR UPDATE`) so two changes to the same workspace run one after the other, then refuses to demote or remove the only owner (`OD409 LAST_OWNER`). The deferred constraint trigger (`private.assert_org_has_owner`) stays as the backstop at commit. Mutation checks: removing the admin owner-grant check fails 4 pgTAP assertions; disabling the function-level guard fails 6; removing the row lock fails both concurrency tests (two owners demoting, and removing, each other at once).
- **Limits.** At most 100 open invitations per workspace (`OD429`); an existing member cannot be invited (`OD409`); an expired, unanswered invitation is closed when the address is invited again.
