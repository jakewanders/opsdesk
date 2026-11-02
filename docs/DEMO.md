# Public demo: Turnstile and anonymous sign-in

The live demo signs visitors in anonymously (no email) behind a Cloudflare Turnstile challenge. Supabase Auth verifies the Turnstile token itself, so no anonymous user is created unless the challenge passes. This file covers configuration and checks; the entry flow is SIT-204 and the workspace bootstrap is SIT-199.

## How it fits together (PRD 8.1)

1. The `/demo` page runs the Turnstile widget (invisible by default, with an accessible fallback) and gets a token.
2. The browser calls `supabase.auth.signInAnonymously({ options: { captchaToken } })`.
3. Supabase Auth checks the token with Cloudflare. Only on success does it create the `auth.users` row (`is_anonymous = true`); the profile trigger (SIT-167) then adds a profile named `Demo User`.
4. The browser calls `POST /api/v1/demo/bootstrap` with the session (SIT-199 and SIT-204).

Supabase applies CAPTCHA to every public auth endpoint, not only anonymous sign-in: sign-up, sign-in with password, and password reset also need a token. The login, signup, and forgot-password forms (SIT-179, SIT-189) must therefore run the widget too.

## Fail safely

- The app must not call `signInAnonymously` without a token. If the Turnstile script cannot load, times out, or the challenge fails, show a friendly retryable error and links to the static technical overview. Never show a fake "demo started".
- The database side is verified: a request with no token, or an empty token, is rejected with `captcha_failed` and creates no user; a token the provider rejects is also refused (see Verification).

## Keys

| Key        | Where                                                                                       | Notes                                           |
| ---------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Site key   | `NEXT_PUBLIC_TURNSTILE_SITE_KEY`                                                            | Public; ships in the browser bundle.            |
| Secret key | Supabase (CAPTCHA settings); `TURNSTILE_SECRET_KEY` only if the app itself calls Cloudflare | Never in the repository, never `NEXT_PUBLIC_*`. |

### Local development: Cloudflare's dummy keys

Cloudflare publishes dummy Turnstile keys for testing ([docs](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)). They are not secrets.

| Purpose                         | Site key                   | Secret key                            |
| ------------------------------- | -------------------------- | ------------------------------------- |
| Always passes (default locally) | `1x00000000000000000000AA` | `1x0000000000000000000000000000000AA` |
| Always blocks                   | `2x00000000000000000000AB` | `2x0000000000000000000000000000000AA` |

`supabase/config.toml` enables anonymous sign-ins and CAPTCHA (`provider = "turnstile"`) with the always-pass secret. A unit test fails if that value is anything other than a Cloudflare dummy secret, and another fails if a real-looking Turnstile key (`0x4...`) appears anywhere in tracked text files. The always-pass secret accepts any non-empty token (Cloudflare's own dummy token is `XXXX.DUMMY.TOKEN.XXXX`). Local verification calls Cloudflare's verification service, so it needs internet access.

## Hosted project checklist (needs the Supabase and Cloudflare owner)

Tracked for production in P-14 (Supabase Auth URL settings, Turnstile production keys) and P-15 (go/no-go checks).

- [ ] Cloudflare: create a Turnstile widget for hostname `opsdesk.sitelaunch.dev` (and a separate one for local or preview hosts if wanted). Mode: managed or invisible. Copy the site key and secret.
- [ ] Supabase dashboard, Authentication, Sign In / Providers: **Allow anonymous sign-ins** on.
- [ ] Supabase dashboard, Authentication, Attack Protection: **CAPTCHA protection** on, provider **Cloudflare Turnstile**, paste the production **secret**.
- [ ] Supabase dashboard, Authentication, Rate Limits: review **Anonymous users** (hourly per IP; local default 30) against expected demo traffic and the free-tier limits.
- [ ] Netlify environment variables: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (production site key). Add `TURNSTILE_SECRET_KEY` only if server code verifies tokens itself.
- [ ] Verify on the production hostname: a request with no token is rejected; a normal visit to `/demo` signs in.

## Verification commands

```bash
npm run db:start            # local stack with anonymous sign-ins and CAPTCHA on
npm run test:integration    # no token and empty token rejected, dummy token accepted, profile created
npm run test:unit           # config.toml safety tests
```

Manual probe (local):

```bash
KEY=$(npx supabase status -o json | python3 -c "import json,sys; print(json.load(sys.stdin)['PUBLISHABLE_KEY'])")
curl -s -X POST http://127.0.0.1:54321/auth/v1/signup -H "apikey: $KEY" -H "Content-Type: application/json" -d '{}'
# -> 400 captcha_failed (no captcha_token found)
```

## Database support for the demo lifecycle (SIT-191)

Migration `20261101000600_demo_workspaces.sql`. The bootstrap and reset RPCs (SIT-199, SIT-205) and the cleanup job (SIT-207) build on these structures.

- **`public.demo_workspaces`**: one row per demo, `organization_id` (primary key), `user_id` (the anonymous identity, **unique**), `seed_version` and `seeded_at`, `last_reset_at`, timestamps. A composite foreign key `(organization_id, kind) -> organizations (id, kind)` with `kind` pinned to `demo` means a real organization can never be registered as a demo.
- **One demo per identity** is decided by the database: the unique `user_id` is the arbiter when two bootstrap calls race (the loser gets `23505`). An expired demo keeps its row until the cleanup job deletes the organization (the row cascades), which frees the identity for a fresh demo: that is the "after cleanup rules allow" rule.
- **Lifetime**: `private.demo_ttl()` is 24 hours; `expires_at` is set at creation and changed only through `private.set_demo_expiry` (SIT-188), so a client cannot extend it.
- **Reset throttle**: `private.begin_demo_reset(org)` claims a reset atomically (the `UPDATE` is the lock): allowed when `last_reset_at` is empty or at least a minute old, otherwise `OD429 DEMO_RESET_THROTTLED` with a `retry-after` hint. Not callable by browser roles.
- **Seed version**: `private.record_demo_seed(org, version)` stores which seed populated the workspace (version >= 1, with `seeded_at`), so a reset can restore exactly that version.
- **Access**: RLS on; an owner can read their own row; no insert/update/delete grants and restrictive denial policies; `seed_version`, `seeded_at` and `last_reset_at` are also refused by a trigger for any role except `postgres`, `supabase_admin`, `service_role`; the helpers' EXECUTE is for `service_role` (and the owner-run definer RPCs) only.
- **Cleanup index**: the partial index `organizations_demo_expiry_idx (expires_at) where kind = 'demo'` serves the scan. Real plan on the local database with 5,000 demo organizations, 800 of them expired, seq scans enabled (the planner chooses it on its own):

```
 Limit (actual rows=100 loops=1)
   ->  Index Scan using organizations_demo_expiry_idx on organizations (actual rows=100 loops=1)
         Index Cond: (expires_at < now())
```

A pgTAP test also asserts the plan uses the index.

## Demo seed registry and fixtures (SIT-192)

Migration `20261101000700_demo_seed_registry.sql`. One mechanism seeds a demo workspace for both bootstrap (SIT-199) and reset (SIT-205).

### How seeding works

- `private.seed_demo_workspace(org_id)` runs every registered seeder, in `position` order, **inside the caller's transaction** (a failing seeder rolls the whole seed back), then records the seed version with `record_demo_seed`.
- It accepts only an organization that is a **demo** and has a `demo_workspaces` row (the calling RPC has already validated and registered its own org; it never takes an id from client input). Real organizations raise `OD403`, unknown or unregistered ones `OD404`.
- **Idempotent**: a workspace whose stored `seed_version` is at least the current `private.demo_seed_version()` is left alone. The seed version is `1 + the sum of every registered seeder's version`.
- **Reset**: empty the workspace's data, call `private.clear_demo_seed_marker(org_id)`, then `seed_demo_workspace` again. Call the runner only on a fresh or emptied workspace (a newly registered seeder raises the version, and seeding a populated workspace would duplicate rows).
- All of these are executable by `service_role` and the owner-run definer RPCs only, never by browser roles.

### Adding a seeder for a new entity (customers, opportunities, tasks, quotes, activity)

1. In the entity's migration, write `private.seed_<entity>(org_id uuid) returns void` that inserts the rows using the fixtures below and `private.demo_ts(days_ago, hour)`. Reference parent rows by looking them up in this org (never by a hard-coded id): ids are random per workspace, content is not.
2. Register it with **one call**: `select private.register_demo_seeder('<entity>', <position>, 'private.seed_<entity>(uuid)'::regprocedure);` Lower positions run first, so a parent (customers, 10) seeds before its children (opportunities, 20; tasks, 30). Bump the optional `seeder_version` argument when the content changes.
3. Seeded activity events have no actor (`System`, a null actor).
4. Add the rows to the manifest check in the verification issue (SIT-258). The fixture lint test (`src/lib/demo/fixture-lint.test.ts`) automatically scans any migration that mentions the seed registry or fixtures.

### Fixtures (all deterministic, no `random()`)

`private.demo_company(i)`, `demo_person(i)`, `demo_first_name(i)`, `demo_last_name(i)`, `demo_email(i)`, `demo_phone(i)`, `demo_ts(days_ago, hour)`. Index `i` is 1-based and wraps after 24, so the same `i` always yields the same value. Fiction rules (PRD 8.2): invented company names, `first.last@example.com` addresses, phones `(202) 555-01NN` (the 555-0100..0199 block is reserved for fiction), no real people or brands. Dates are offsets from today, 0 to 90 days back.

### Manifest (target contents; `src/lib/demo/seed-manifest.ts`)

| Entity                    | Count    |
| ------------------------- | -------- |
| customers                 | 18       |
| opportunities             | 10       |
| tasks                     | 24       |
| quotes (when enabled, M4) | 4        |
| activity events           | about 40 |

### Local use

`npm run demo:seed` creates a throwaway demo organization in the **local** database (it refuses any non-local target) and seeds it; it prints the SQL to remove it. With no entity seeders registered yet it records the framework seed version (1).

## Demo caps (SIT-200)

Migration `20261101001000_demo_caps.sql`. Demo data is capped in the database, not only in the UI.

| Entity          | Cap per demo workspace | Limit key (`private.app_limits`) |
| --------------- | ---------------------- | -------------------------------- |
| customers       | 50                     | `demo_cap_customers`             |
| opportunities   | 30                     | `demo_cap_opportunities`         |
| tasks           | 75                     | `demo_cap_tasks`                 |
| quotes          | 20                     | `demo_cap_quotes`                |
| activity events | 300 (non-essential)    | `demo_cap_activity_events`       |

- **Attach in one line**, in the entity's migration right after creating the table and its `organization_id` index: `select private.attach_demo_cap('public.customers', 'demo_cap_customers');`. **Every entity issue lists "attach cap trigger" in its acceptance criteria** (customers SIT-208, opportunities SIT-216, tasks SIT-220, quotes SIT-222, activity SIT-195/201). The activity table passes a count filter that leaves essential audit events out: `select private.attach_demo_cap('public.activity_events', 'demo_cap_activity_events', 'not is_essential');`.
- The trigger (`private.enforce_demo_cap`, a SECURITY DEFINER BEFORE INSERT trigger) applies only to organizations of `kind = 'demo'`, counts that organization's rows (**all rows, archived included**, so archiving cannot bypass a cap) through the `organization_id` index, and refuses the insert past the cap with `OD429` / `DEMO_CAP` and a `retry-after=60` hint. A per-workspace-per-table advisory lock serializes concurrent inserts so two cannot both pass at cap - 1. Real organizations are never counted.
- **429 in the standard envelope:** the API error mapper turns `OD429` into HTTP 429 with code `DEMO_CAP`, the message "Demo limit reached for customers. Reset the demo to start over." and a `Retry-After` header (verified end to end in `demo-caps.integration.test.ts`).
- **Activity ceiling blocks the mutation.** The activity insert happens inside the same transaction as the change that caused it, so when the activity cap refuses the event the originating mutation fails with it: no change is ever saved without its audit event. Deleting rows (reset, cleanup) is never capped, so they stay available.
- Change a cap with `update private.app_limits set value = N where key = '...'` (no client access); tests lower them the same way.

## Resetting a demo (SIT-205)

Migration `20261101001100_reset_demo_workspace.sql`. `public.reset_demo_workspace(org_id)` lets a guest restore the exact seed state of **their own** demo.

- **Who:** an anonymous guest (JWT claim and stored user both) who owns that demo (their `demo_workspaces` row). Another guest's organization, a real organization and an unknown id all get the same `OD404` "That demo workspace was not found", so existence never leaks; a registered user gets `OD403 GUEST_ONLY` and no real organization is ever touched; the guest's own **expired** demo is `OD403 DEMO_EXPIRED`.
- **What (one transaction):** claim the throttle (`private.begin_demo_reset`: one reset per minute, `OD429 DEMO_RESET_THROTTLED` with a retry-after hint) -> run the registered **clear functions** in reverse position order (`private.clear_demo_data`) -> clear the seed marker -> `private.seed_demo_workspace`. The organization, its owner membership, `expires_at` and every user account are untouched: a reset never extends the 24 hours. Any failure rolls back everything, including the throttle claim, so a failed reset neither loses data nor uses up the minute.
- **Registering how to clear:** an entity seeder passes a clear function as the fifth argument: `select private.register_demo_seeder('customers', 10, 'private.seed_customers(uuid)'::regprocedure, 1, 'private.clear_customers(uuid)'::regprocedure);`. A clear function deletes only `where organization_id = org_id`. The activity table (SIT-195/201) registers one that uses the privileged path its append-only trigger allows, scoped to the organization. Tables that cascade from `organizations` do not need one, but the registry is how reset learns the order (children first).
- **Idempotency token:** not used. The per-minute throttle already bounds a retried or double-clicked reset (two simultaneous resets let exactly one through), and SIT-183's token helper is not built yet.
- The HTTP route and the confirmation UI are SIT-210.

## Expiry: where it is enforced, and how to test it (SIT-206)

A demo lasts 24 hours from creation. Expiry is computed from the database `expires_at`, never from a client clock, and is enforced at every layer.

| Layer        | What happens after `expires_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Database** | `private.org_is_writable` is false (strictly `expires_at > now()`), so every insert, update and delete is refused by RLS, even for a client calling the Supabase SDK directly. A guest cannot extend `expires_at` (no grant, plus the immutability trigger). Reads still work until cleanup removes the data.                                                                                                                                                                                                                                 |
| **API**      | `withOrgApi` answers `403 DEMO_EXPIRED` in the standard envelope (routes that must still answer, such as the session, pass `allowExpired`).                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Proxy**    | A guest whose demo expired is redirected from `/app` to `/demo` (SIT-180).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **UI**       | While live, a banner (`DemoCountdown`) shows the time left from the server's clock plus this tab's monotonic elapsed time (a wrong device clock changes nothing); it announces to screen readers only at 60, 10, 5 and 1 minute and at expiry. After expiry `/demo` shows "Your demo has ended" with **Start a new demo**, which restarts the demo with the guest's existing session (`bootstrap_demo_workspace` deletes their own expired demo and creates a fresh, freshly seeded one). A demo is never converted into a real organization. |

**Every tenant table gets the same policies from one call:** `select private.attach_tenant_rls('public.customers');` creates `select` for members and `insert`/`update`/`delete` for owner, admin and member of a _writable_ organization (`private.can_write`), revokes everything from `anon`, and enables RLS. A catalog test fails if any permissive write policy on a table with `organization_id` does not require `can_write` / `org_is_writable`, so a later entity cannot forget expiry. Entity issues list "attach tenant RLS and the demo cap" in their acceptance criteria.

**Test hooks for simulating expiry** (local database only; the trusted roles `postgres` / `service_role` may do this, a browser role may not):

- SQL: `select private.set_demo_expiry('<org uuid>', now() - interval '1 minute');` (or `update public.organizations set expires_at = now() - interval '1 minute' where id = '<org uuid>'` as `postgres`).
- pgTAP: the same call inside the test transaction (see `supabase/tests/demo-expiry.test.sql`); boundary cases are one second before and exactly at `expires_at`.
- Integration and browser runs: `psql`/`update` through the local container, as `src/test/demo-expiry.integration.test.ts` and `src/lib/demo/restart.integration.test.ts` do. Cleanup of expired data is SIT-207.
