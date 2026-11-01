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
