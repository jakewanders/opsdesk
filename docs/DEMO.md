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
