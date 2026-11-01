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
