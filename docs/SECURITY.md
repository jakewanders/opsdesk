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
- The workspace state is read with the caller's own session (`resolveWorkspaceState`). If it cannot be determined (query refused or failing) the result is `unknown` and nothing redirects. **Until the tenancy policies of SIT-194 exist, `memberships` is closed to clients, so the state is `unknown` in practice and the org-setup and expired-demo redirects are inert.** They are covered by unit tests with every state and by an integration test that installs a temporary policy.
- A fixpoint test walks every user kind, workspace state and start path and fails if any chain takes more than two redirects.

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
