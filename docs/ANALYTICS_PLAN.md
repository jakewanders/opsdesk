# Google Analytics 4 plan (P-03, reopened)

**Status: plan only. No code, package, env var or copy has changed.** Owner decision (Jake, 2026-11-03): implement Google Analytics for what was P-03 "Optional minimal analytics behind a flag" (parent SIT-146). P-03 was closed as won't-do for v1 (`docs/DECISIONS.md` row dated 2026-11-03, `docs/PROGRESS.md` entry "P-03"). That row's reopening conditions (anonymous aggregate events only; no IP, names, e-mails, notes or query strings; off by default; a test that flag-off records nothing) are kept here. Its "stored rows" wording assumed an in-house event table; GA4 replaces that table, so the "no banned field stored" test becomes a "no banned field is ever sent" test (section 7).

**Not legal advice.** Legal and GA4-behaviour statements below are from general knowledge and were NOT re-verified against live documentation (no web access was used for this draft). Every such statement carries a "verify" marker in section 10. Items I could not verify in the repo are marked **(unverified)**.

---

## 1. Goals, non-goals, and why GA4

### 1.1 Questions analytics should answer

OpsDesk is a portfolio demo. The audience is hiring managers and clients. Useful questions:

1. How many visitors reach the landing page, and from what kind of referrer (GitHub, LinkedIn, direct, a proposal link)?
2. What share click "Try Live Demo", and what share of those get a working demo (bootstrap success vs Turnstile or bootstrap failure)?
3. How far do demo users get: first customer, first pipeline move, first quote, quote PDF, CSV export?
4. Do visitors read the technical overview, the repository link, `/privacy`, `/terms`?
5. Where does the demo break: Turnstile failure, bootstrap failure, expired demo, error panels (request id only)?

### 1.2 Non-goals

- No per-user profiles, retargeting, advertising, Google Signals, ad personalization, remarketing audiences.
- No User-ID, no linking GA to Supabase `auth.users` ids, org ids, workspace ids.
- No analytics for real (non-guest) accounts' business data. No session replay, heatmaps, A/B tests.
- No server-side GA (Measurement Protocol) in v1; the flag keeps the server free of Google calls.
- Not a compliance claim: this makes the privacy copy accurate, it does not certify GDPR/CCPA compliance.

### 1.3 Options compared

| Option                          | Fits the questions?                                   | Privacy / consent burden                                                                                                         | Cost / ops                                 | Notes                                                                                   |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| **GA4**                         | Yes: funnels, key events, free                        | Highest. Cookies (`_ga`, `_ga_<id>`) so consent is needed for EU/UK; data goes to Google; adblock loss is large for dev audience | Free; UI is heavy; 2 or 14 month retention | Chosen by owner. Also a portfolio signal ("has used GA4 properly with consent and CSP") |
| Plausible (hosted or self-host) | Yes: custom events, goals, funnels (paid)             | Lowest: cookieless, no personal data; usually no banner                                                                          | Paid hosted, or self-host a server         | Best privacy fit for a privacy-minded demo; not what the owner chose                    |
| Umami (cloud or self-host)      | Yes: events, funnels                                  | Low: cookieless                                                                                                                  | Free cloud tier or self-host DB            | Close second; open source                                                               |
| Netlify Analytics               | No: server-side traffic counts only, no custom events | None client-side                                                                                                                 | Paid add-on; needs the Netlify site        | Answers question 1 only; cannot see demo steps                                          |

**Recommendation.** Because the owner chose GA4, implement GA4 but behind the architecture below, which keeps the vendor swappable: all calls go through `src/lib/analytics/track()`, so replacing GA4 with Plausible or Umami later is one adapter file. Mitigate GA4's weaknesses by: no GA script until the visitor opts in (strict opt-in everywhere, section 2.3), no GA at all for real accounts, and a pre-sanitized event taxonomy. If consent-rate or ad-blocker loss makes the data useless, the documented fallback is Plausible/Umami.

Why GA4 is acceptable here: fictional data only (`docs/DEMO.md`, `FictionalDataNote`), anonymous guest identities with no email, 24 hour expiry, and the allowlist stops anything else leaving the browser.

---

## 2. Privacy and legal

### 2.1 What the repo says today (must change)

- `src/app/(marketing)/privacy/page.tsx`: section "Analytics" says "No analytics are collected today. If analytics are added later they will be optional, off by default, and limited to anonymous counts of events such as "demo started". They will not record IP addresses, names, email addresses, the text you type, or full page addresses with query strings, and this page will say so before they are switched on."
- Section "Cookies and local storage" lists only sign-in cookies and theme; ends "There are no advertising cookies."
- Section "Services that process data" lists Netlify, Supabase, Cloudflare Turnstile.
- `src/app/(marketing)/legal-pages.test.tsx` line ~96 asserts `/No analytics are collected today/` and `/local\s+storage/`. Line ~57 forbids `we (do not|don't|never) (collect|store|track)`. **This test must be updated in the same change as the copy** (it will fail otherwise, which is the desired guard).
- Terms (`src/app/(marketing)/terms/page.tsx`) has no analytics/cookie mention (grep found none). It needs one short cross-reference sentence, not a policy.

**Rule: the privacy page and behaviour must agree at every deploy.** The page must say "analytics are on, consent-based" exactly when `NEXT_PUBLIC_ENABLE_ANALYTICS=true` and an id is set in production. Because the page is static (marketing layout, "static and cacheable"), the copy cannot branch on the flag at request time safely under Cache Components; instead ship the new copy in the same release that first sets the flag, and add a test (section 7) that fails if the flag defaults to true while the copy still says "No analytics are collected today".

### 2.2 Draft replacement wording

**/privacy, "Analytics" section (replaces the current paragraph):**

> **Analytics (optional, off until you agree)**
> With your permission, OpsDesk uses Google Analytics 4 on the public pages and during the live demo to count anonymous events such as "demo started" or "customer created in the demo", and which pages are viewed. Nothing is sent to Google until you choose "Accept analytics" in the banner; "Decline" (the default if you ignore the banner, or if your browser sends Global Privacy Control or Do Not Track) sends nothing and sets no analytics cookies.
> If you accept, Google sets cookies named `_ga` and `_ga_` followed by an ID, which last up to two years unless you clear them, and receives the event name, a page path without query strings, your browser type, approximate location derived from your IP address, and a random client ID. Google Analytics 4 does not log or store IP addresses. We do not send names, email addresses, text you type, record contents, workspace or organization IDs, or search terms. We have turned off Google signals and advertising features and do not use the User-ID feature. Analytics events are kept for [2 / 14] months. Analytics is never loaded for signed-in real accounts. Google acts as a service provider for this data; its terms and privacy policy apply, and data may be processed in the United States and other countries. You can change your choice at any time with the "Analytics preferences" link in the footer.

**/privacy, "Cookies and local storage" additions (bullets):**

> - **Analytics cookies** (`_ga`, `_ga_<id>`), only if you accept analytics; they hold a random identifier so repeat visits can be counted. Up to 2 years.
> - **Analytics choice** (`opsdesk-analytics-consent`) in your browser's local storage records whether you accepted or declined; it never leaves your browser.
>
> Replace "There are no advertising cookies." with "There are no advertising cookies; advertising features in Google Analytics are turned off."

**/privacy, "Services that process data":** append "Google (Google Analytics 4), only if you accept analytics."

**/terms, new short section "Analytics":** "If you accept analytics, the demo counts anonymous usage events as described in the Privacy page. Do not enter real personal information in the demo; analytics never receives what you type." (Keep consistent with the existing "Fictional data only" section.)

**Page-level `description` metadata in privacy** currently says "demo sessions, real accounts, cookies, and logs": keep; optionally add "analytics".

### 2.3 Consent approach

Options:

| Approach                                                                                  | Verdict                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Cookie banner, **do not load gtag.js at all until Accept** (strict opt-in, everywhere) | **Recommended.** Simple, strongest, no pings before consent, no region detection (Netlify geo headers are not needed), easy to test (zero requests to Google before accept). Cost: lower sample size, no modeled data, acceptable for a portfolio.           |
| B. Google Consent Mode v2, load gtag with defaults `denied`, update on accept             | Sends cookieless pings to Google even when denied (I believe; **verify**). Many EU regulators/lawyers still treat that as processing needing a lawful basis. Adds `ad_user_data`/`ad_personalization` plumbing we do not need as we do no ads. Not worth it. |
| C. No banner, rely on "legitimate interest"/US opt-out only                               | Not acceptable for EU/UK visitors for GA4 cookies (ePrivacy/PECR need prior consent for non-essential cookies; **owner to confirm with counsel**). Rejected.                                                                                                 |

If Consent Mode v2 is ever adopted, set `analytics_storage`, `ad_storage`, `ad_user_data` and `ad_personalization` all to `denied` by default and only `analytics_storage` to `granted` on accept; `ad_*` always stay denied. Google's "Consent Mode" documentation (developers.google.com/tag-platform/security/guides/consent) is the reference **(verify current names/behaviour)**.

Banner design (public pages and `/demo`): small bottom bar, two equal-weight buttons "Accept analytics" and "Decline", link to `/privacy#analytics`; no dark patterns; default is decline; remembered in `localStorage["opsdesk-analytics-consent"]` as `"granted" | "denied"` with a version and timestamp, re-asked after 12 months or if the policy version changes; a footer link "Analytics preferences" reopens it. Declining must be as easy as accepting. The banner is a client component; wrap `localStorage` access in try/catch (blocked storage means denied). The marketing pages stay statically prerendered (the banner mounts client-side after hydration); it must not cause layout shift (fixed-position).

EU/UK: opt-in before any non-essential cookie or tracking (GDPR + ePrivacy; UK PECR). Also GDPR concerns: transfers to US (EU-US Data Privacy Framework status of Google LLC: **verify**), a data processing amendment accepted in GA admin (section 6), and Google's own requirement that the site owner gets consent where required (Google EU User Consent Policy). US states: most state privacy laws (CCPA/CPRA, etc.) are opt-out and treat sharing for cross-context advertising as the trigger; with ads features and signals off and no sale/sharing this is low risk, but honoring GPC is legally required in some states (California, Colorado, others) for opt-out preference signals; we treat GPC as decline everywhere. **Owner must confirm** with counsel: (1) whether the privacy page needs a named controller/contact (`/privacy` currently says contact will be published "before real accounts open"; with GA live a contact route is needed, at minimum an email), (2) whether Google's "Data Processing Terms" are accepted in the property, (3) children/minor concerns (demo is not directed at children), (4) whether the owner is subject to any law at all (an individual portfolio site in the US, with EU visitors, is subject to GDPR when it monitors EU visitors).

### 2.4 GA4 data handling facts (verify each)

- IP addresses: GA4 does not log or store IP addresses; it uses them transiently for geolocation (Google's "IP anonymization in Analytics" help page). There is no "anonymize IP" toggle in GA4 (it was a UA feature; **verify**).
- Data retention: event-level data retention for standard properties is 2 months or 14 months only (Admin > Data collection and modification > Data retention). The default is 2 months. Standard reports/aggregations are not limited by this setting, only explorations and user-level data. Recommend **14 months** only if year-over-year comparison matters; otherwise keep 2 months (less data held). Copy above has `[2 / 14]` placeholder to fill in after the owner decides. Also leave "Reset user data on new activity" on or off per taste (**verify**; it is relevant only to retention behaviour).
- Google signals: off (Admin > Data collection > Data collection > Google signals). Ad personalization: also disable at data stream level (Admin > Data streams > stream > Configure tag settings > Google tag > "Allow ads personalization"/Manage; **verify exact menu**) and send `allow_google_signals: false` and `allow_ad_personalization_signals: false` in the gtag `config` call as defense in depth.
- User-ID: never call `gtag('set', {user_id})`; never set `user_properties` with identifiers. Test asserts the allowlist rejects `user_id`/`user_properties`.
- Cookie: `_ga` (2 years) and `_ga_<container-id>` (2 years) set first-party on the host. Set `cookie_expires` lower (e.g. 63072000 default; could set 6 months = 15552000) via config **(verify the `cookie_expires` parameter)**; the copy must state the actual value. Recommendation: `cookie_expires: 15552000` (about 6 months) and update copy to "up to six months".
- Do not upload PII; Google's terms prohibit sending PII; the allowlist enforces it.

---

## 3. What to track

### 3.1 Where GA loads (policy)

| Area                                                                                              | Load GA?                                                                                                    | Why                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(marketing)`: `/`, `/privacy`, `/terms` (`src/app/(marketing)/`)                                 | Yes, after consent                                                                                          | Public, no user data. Answers questions 1, 2, 4.                                                                                                                                                                                         |
| `(auth)`: `/demo`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/invite`, `/auth` | `/demo` and `/signup`, `/login` pages: yes after consent. `/reset-password`, `/invite/*`, `/auth/*`: **no** | Reset and invite URLs carry tokens/hashes/codes in path or query (`SECRET_KEY` regex in `src/lib/logger/redact.ts` treats `token`, `invit`, `session`, `captcha` as sensitive). Exclude them by allowlisting routes, not by denylisting. |
| `/app/**` as a **guest** (`user.isAnonymous`, demo workspace)                                     | Yes, only anonymous demo-journey events, after consent                                                      | The funnel (first customer, first stage move, first quote) happens inside `/app`. Data is fictional and the identity is a random anonymous user. Events carry no ids, no names, no counts of private data.                               |
| `/app/**` as a **real signed-in account** (email, real customers, quotes)                         | **No. GA is never loaded.**                                                                                 | Real tenants' business data lives there (`docs/SECURITY.md` cross-tenant threat model; privacy page promises "Nothing is sent about real workspaces"). Cannot guarantee a non-leaking `page_location`, titles contain customer names.    |
| `/api/**`                                                                                         | n/a (server)                                                                                                | No server-side GA in v1.                                                                                                                                                                                                                 |

Implementation: `src/app/app/layout.tsx` `DynamicShell` already knows `user.isAnonymous` server-side. Pass `analyticsScope="guest" | "none"` to a client `<AnalyticsProvider>` rendered inside the shell; for non-guests render nothing (not just a disabled client, so the script is absent from the HTML). A user who upgrades from guest to real account (if that flow exists, **unverified**) stops being tracked on the next render.

Because `/app` page titles and URLs can contain customer names or ids (e.g. `/app/customers/<uuid>`), **`page_view` is sent manually with a route template**, never the raw URL: `/app/customers/[id]`, `/app/opportunities`, `/app/quotes/[id]`, etc. `page_title` is set to the template label too. Auto page views from enhanced measurement are disabled in the tag config (`send_page_view: false`) and the "Page changes based on browser history events" box turned off in the stream (section 6).

### 3.2 Event taxonomy

Naming: GA4 recommended event names where one fits (`page_view`, `login`, `sign_up`, `generate_lead` is not used), snake_case custom names otherwise. All custom event names are <= 40 chars; parameter names <= 40; values are short enums or small ints (GA limits: 500 distinct event names per property, 25 parameters per event, parameter value <= 100 chars, **verify**).

Global parameters added automatically by `track()` (all enums): `app_area` (`marketing|demo|app_guest`), `ui_viewport` (`mobile|desktop`, optional). Nothing else global. **Not** sent: user id, org id, workspace id, display name, email, any record id.

| Event name                                     | Params (allowlisted keys)                                                                                                              | Fires where (real file/route)                                                                                                                                                                                                                                       | Key event?                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `page_view`                                    | `page_path_template`, `page_title_template`                                                                                            | `AnalyticsProvider` on route change (`usePathname`, templated) in marketing, `/demo`, guest `/app`                                                                                                                                                                  | no                                                                                     |
| `cta_click`                                    | `cta_id` (`hero_try_demo`, `nav_try_demo`, `hero_repo`, `tech_overview`, `footer_privacy`, `footer_terms`, `footer_repo`), `placement` | `src/app/(marketing)/_components/landing-page.tsx`: Try Live Demo links (nav line ~85 and hero line ~104), repo link (~109), overview anchor (~118), footer links (~245-253)                                                                                        | `cta_click` with `cta_id=hero_try_demo` is the funnel start: mark `demo_start` instead |
| `demo_start`                                   | `source` (`hero                                                                                                                        | nav                                                                                                                                                                                                                                                                 | direct`)                                                                               | `src/components/demo/demo-entry-client.tsx` when the visitor lands on `/demo` and the sign-in is attempted (after Turnstile token obtained) | **yes**                                                                                                                                       |
| `demo_bootstrap_success`                       | `duration_bucket` (`lt2s                                                                                                               | 2to5s                                                                                                                                                                                                                                                               | gt5s`), `retry` (`0                                                                    | 1`)                                                                                                                                         | `demo-entry-client.tsx` after `POST /api/v1/demo/bootstrap` succeeds                                                                          | **yes**                                                                                 |
| `demo_bootstrap_failure`                       | `reason` (`turnstile_failed                                                                                                            | turnstile_blocked                                                                                                                                                                                                                                                   | rate_limited                                                                           | bootstrap_failed                                                                                                                            | network`), `request_id` (only the app's own request id, see 3.4)                                                                              | same component, failure branch (Turnstile load/fail, `captcha_failed`, bootstrap error) | no  |
| `sign_up` (GA recommended)                     | `method` (`email`)                                                                                                                     | signup form success, `src/components/auth/auth-form.tsx` (signup mode). **Never** the email. Only on public `/signup` page; fires before redirect                                                                                                                   | **yes**                                                                                |
| `login` (GA recommended)                       | `method` (`email`)                                                                                                                     | `auth-form.tsx` login mode success. After sign-in the user is a real account so no more events in `/app`                                                                                                                                                            | no                                                                                     |
| `first_customer_created`                       | none                                                                                                                                   | guest `/app/customers`: customer create success in `src/features/customers/components/*` (create form) or its API mutation hook (`src/lib/api-client/use-api-mutation.ts` is generic; fire from the feature's `onSuccess`). Once per demo via `sessionStorage` flag | **yes**                                                                                |
| `customer_created`                             | none                                                                                                                                   | same place, every time (guest only)                                                                                                                                                                                                                                 | no                                                                                     |
| `first_stage_move` / `opportunity_stage_moved` | `from_stage`, `to_stage` (enum of the pipeline stage names)                                                                            | `src/features/opportunities/use-move-stage.ts` success (drag or select); first-time flag in sessionStorage                                                                                                                                                          | `first_stage_move` **yes**                                                             |
| `task_completed`                               | none                                                                                                                                   | `src/features/tasks/use-complete-task.ts` success                                                                                                                                                                                                                   | no                                                                                     |
| `quote_created`                                | `has_tax` (`0                                                                                                                          | 1`), `line_count_bucket` (`1                                                                                                                                                                                                                                        | 2to5                                                                                   | gt5`)                                                                                                                                       | `src/features/quotes/components/*` quote create success. Note: amounts and customer names are NOT sent                                        | **yes**                                                                                 |
| `quote_sent_simulated`                         | none                                                                                                                                   | quote status change to sent (simulated, no email: `src/features/quotes/no-outbound.test.ts` guards that nothing leaves); `quote-status.tsx` area                                                                                                                    | no                                                                                     |
| `quote_pdf_downloaded`                         | none                                                                                                                                   | quote PDF download (`src/features/quotes/pdf.ts` caller / button)                                                                                                                                                                                                   | no                                                                                     |
| `csv_import_completed`                         | `row_count_bucket` (`1to10                                                                                                             | 11to100                                                                                                                                                                                                                                                             | gt100`), `had_errors` (`0                                                              | 1`)                                                                                                                                         | `src/features/customers/import/*` on import success (file name and contents never sent)                                                       | no                                                                                      |
| `csv_export_clicked`                           | `entity` (`customers                                                                                                                   | opportunities                                                                                                                                                                                                                                                       | tasks                                                                                  | quotes                                                                                                                                      | activity`)                                                                                                                                    | `src/features/exports/export-csv-button.tsx`                                            | no  |
| `demo_reset`                                   | none                                                                                                                                   | `src/components/demo/demo-reset-button.tsx` success                                                                                                                                                                                                                 | no                                                                                     |
| `demo_expired_shown`                           | none                                                                                                                                   | `src/components/demo/demo-ended-panel.tsx` mount (expired demo bounce; `decideRoute` sends expired demos away). Fires on public side if GA is allowed there                                                                                                         | no                                                                                     |
| `error_shown`                                  | `error_area` (`app_error                                                                                                               | not_found                                                                                                                                                                                                                                                           | backend_unavailable                                                                    | api_error`), `error_code`(the API error`code`enum),`request_id`                                                                             | `src/components/shared/error-panel.tsx`, `src/app/error.tsx`, `src/app/not-found.tsx`, `backend-unavailable.tsx`. Never the message or digest | no                                                                                      |
| `demo_journey_completed`                       | none                                                                                                                                   | derived client-side: fired once when the guest has fired `first_customer_created`, `first_stage_move` and `quote_created` in this browser session                                                                                                                   | **yes**                                                                                |

Key events (formerly "conversions"; marked in GA4 Admin > Key events): `demo_start`, `demo_bootstrap_success`, `first_customer_created`, `first_stage_move`, `quote_created`, `demo_journey_completed`, `sign_up`. Keep the number small: they exist to build the funnel, not to count everything.

### 3.3 Funnel (GA4 Explore > Funnel exploration, built manually)

1. `page_view` with `page_path_template = /` (landing)
2. `demo_start`
3. `demo_bootstrap_success`
4. `first_customer_created`
5. `first_stage_move`
6. `quote_created`
7. (optional) `quote_pdf_downloaded`

"Open funnel" off if the owner wants strict order; GA4 funnel needs the user's cookie to persist across steps, so a consent-declining user is invisible (accepted).

### 3.4 What `request_id` is

`request_id` is the app's own request id (see `src/lib/logger`, the "request id" copy buttons, `src/components/shared/copy-request-id.tsx`), generated per request, not tied to a person. Sending it lets the owner correlate a GA `error_shown` with server logs. The sanitizer accepts only the app's request id format **(format is unverified here; confirm in `src/lib/http` and `docs/API.md`)**, as a strict regex. If it cannot be matched, the param is dropped. Rule for the 'no ids' hard rule: request ids are not workspace/user/record ids; this is the single id exception.

### 3.5 Hard rules (PII)

Never sent, ever: names, email addresses, phone/address, notes, descriptions, quote line text, customer or company names, org names, workspace/organization ids, user ids, record uuids, search terms, filter text, query strings, URL fragments, file names, CSV content, amounts, error messages or stack traces. The `SECRET_KEY`, `CONTENT_KEY`, `CONTACT_KEY` rules in `src/lib/logger/redact.ts` define "sensitive" for the app; the analytics sanitizer reuses `isSensitiveKey` and the email/uuid/JWT patterns as a second layer on top of its own allowlist (section 4.3).

---

## 4. Implementation design (Next.js 16 App Router, Cache Components)

### 4.1 Library vs hand-rolled

| Option                                                                      | Pros                                                                                                                                                                                                                                                                                     | Cons                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@next/third-parties/google` `<GoogleAnalytics gaId=... />` + `sendGAEvent` | Official, small, handles `next/script` and history page views (**verify props: `gaId`, `dataLayerName`, `nonce`, `debugMode`**)                                                                                                                                                          | Loads immediately on mount (must be conditionally rendered after consent: doable); enhanced-measurement page views use the raw URL (cannot be templated, bad for guest `/app`); inline init script needs CSP nonce/hash; new dependency (also requires the maintainers' version to match Next 16.4.3: **verify**) |
| **Hand-rolled client module** (recommended)                                 | Full control: consent-gated load, templated `page_view`, `send_page_view: false`, no inline script (init written in bundled JS, `gtag.js` loaded via `next/script src` with `strategy="afterInteractive"` or a dynamic `<script>` append), no new dependency, `track()` is the only door | We own ~150 lines and the GA snippet semantics                                                                                                                                                                                                                                                                    |

**Recommendation: hand-rolled**, because the three hard requirements (consent-gated loading, templated paths, no inline script for CSP) are awkward with the stock component. No packages to install in this plan.

### 4.2 File layout (proposed; none exist yet)

```
src/lib/analytics/
  events.ts        # the allowlist: event names -> allowed param keys and value validators (zod or plain)
  sanitize.ts      # drops unknown keys, rejects values that look like email/uuid/JWT/long text/ids, strips query/hash
  config.ts        # isAnalyticsEnabled(env, host, consent) pure function
  consent.ts       # read/write localStorage consent, GPC/DNT detection, subscribe()
  gtag.ts          # loadGtag(id), set up window.dataLayer + gtag(), config call; idempotent; never throws
  track.ts         # track(name, params) public API; no-op unless enabled
  route-template.ts# pathname -> template ('/app/customers/abc' -> '/app/customers/[id]'), allowlisted routes only
  *.test.ts
src/components/analytics/
  analytics-provider.tsx   # "use client": loads gtag when allowed, sends page_view on route change
  consent-banner.tsx       # "use client"
public/ (none needed)
```

Placement:

- Root `src/app/layout.tsx` stays untouched except for rendering `<ConsentBanner />` and `<AnalyticsProvider scope="public" />` inside the `ThemeProvider` next to `<ToastProvider />`, **or** (better, to keep scope control) render them in `src/app/(marketing)/layout.tsx` and `src/app/(auth)/layout.tsx`, and render `<AnalyticsProvider scope="guest" />` from `DynamicShell` in `src/app/app/layout.tsx` only when `user?.isAnonymous`. Per-area placement implements the policy in 3.1 structurally (no provider, no script). `(auth)/layout.tsx` content is unverified; read before editing. In the auth group the provider must have a route allowlist (`/demo`, `/login`, `/signup`, `/forgot-password`) and skip everything else.
- Both providers are client components using `usePathname()`. Under Cache Components, `usePathname` in a client component below a static layout is fine; `useSearchParams` is NOT used (we never read query strings). If any server component read `searchParams`/`cookies()` it would need Suspense; we avoid it. Wrap providers in `<Suspense fallback={null}>` as precaution **(verify against Next 16 prerender behaviour with `next build`)**.
- Script strategy: after consent, append `https://www.googletagmanager.com/gtag/js?id=<ID>` with `async`, via `next/script` `strategy="afterInteractive"` (or a dynamic `document.createElement("script")` in an effect). Never `beforeInteractive`. The `gtag()` function and `window.dataLayer` are defined in `gtag.ts` (bundled), so there is no inline `<script>` and the CSP does not need a nonce or `'unsafe-inline'` for analytics (section 5).
- Config call: `gtag("js", new Date()); gtag("config", ID, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, cookie_expires: 15552000, cookie_flags: "SameSite=Lax;Secure" })`. (`cookie_flags` and the other keys: **verify** exact names. Note `SameSite=None;Secure` is Google's default in some versions; Lax is fine for first-party.) Also set `page_location` and `page_referrer` explicitly on every `page_view` to the sanitized/templated values: `page_location = origin + template`, `page_referrer` = referrer origin only (or omitted). GA derives `page_location` from `location.href` by default, which can include query strings, so it MUST be overridden on every event, not just `page_view`: use `gtag("set", { page_location, page_path, page_referrer })` after each navigation **(verify that `set` is honored for subsequent events; otherwise pass on each event)**.
- Event param names that GA auto-collects (`page_location`, `page_referrer`, `page_title`, `language`, `screen_resolution`) cannot be disabled, only overridden; note that "text" and "link_url" are tied to enhanced measurement features that must be turned off.

### 4.3 `track()` and the allowlist

```ts
// src/lib/analytics/events.ts (shape, not final code)
export const EVENTS = {
  page_view: { page_path_template: route, page_title_template: label },
  cta_click: { cta_id: oneOf([...]), placement: oneOf([...]) },
  demo_start: { source: oneOf(["hero","nav","direct"]) },
  ...
} as const;
export function track<N extends EventName>(name: N, params?: ParamsOf<N>): void;
```

Rules enforced in `sanitize.ts` (each has a unit test):

1. Unknown event name: drop, and in non-production console.warn once. Never throw.
2. Unknown param key: drop that key (and in tests, fail via a strict mode flag).
3. Per-key validators: enum values must be members; ints are clamped; `request_id` must match the strict id regex; free strings are not accepted anywhere except through enums.
4. Value screen on everything that survives: reject strings containing `@`, matching email regex, UUID regex, JWT shape (`eyJ...`), the long-opaque regex (40+ chars, reuse `redactOpaque` logic from `src/lib/logger/redact.ts`), `?`, `#`, or longer than 40 chars (except `request_id`). Rejected value: drop the key, not the event.
5. Forbidden keys regardless of allowlist: anything matching `isSensitiveKey` plus `user_id`, `user_properties`, `email`, `name`, `org*`, `workspace*`, `customer*`, `search*`, `query*`.
6. Output a plain frozen object; `track()` calls `window.gtag("event", name, params)` only if `isAnalyticsActive()` (below); no queueing before consent (events before consent are dropped, not buffered, so a later accept does not replay earlier activity).
7. `track()` never throws and never awaits; wrap in try/catch; if `window.gtag` is missing (ad blocker removed script) it returns silently.

### 4.4 Feature flag and env (`src/lib/env`)

- Add `NEXT_PUBLIC_ENABLE_ANALYTICS: booleanFlag("NEXT_PUBLIC_ENABLE_ANALYTICS", false)` to `flagFields` in `src/lib/env/schema.ts`; add `analytics: boolean` to the `FeatureFlags` type and its mapping in `parseFeatureFlags` (mapping function body not read here, **unverified**, follow the existing pattern); add the literal `process.env.NEXT_PUBLIC_ENABLE_ANALYTICS` read to **both** `getPublicEnv` and `getFeatureFlags` in `src/lib/env/public.ts` (comment there: Next inlines only literal `process.env.NAME`). `src/proxy.ts` builds its own `parseFeatureFlags` input for billing/integrations only; analytics does not need a route flag, so no proxy change.
- Add `NEXT_PUBLIC_GA_MEASUREMENT_ID: z.preprocess(emptyToUndefined, z.string().regex(/^G-[A-Z0-9]{6,12}$/).optional())` to `publicEnvSchema` (public id, not secret; GA ids are visible in page source by design). A cross-field `superRefine`: if the flag is true in a production context the id must be present, else a clear `EnvError`; flag true with no id outside production just disables analytics.
- `.env.example`: add `NEXT_PUBLIC_ENABLE_ANALYTICS=false` to the flags block and `NEXT_PUBLIC_GA_MEASUREMENT_ID=` (empty) in the public block, with a comment "public id, safe to expose; leave empty locally".
- `scripts/check-env-names.mjs` (rule: no `NEXT_PUBLIC_*` name contains SECRET, SERVICE or WEBHOOK): `NEXT_PUBLIC_ENABLE_ANALYTICS` and `NEXT_PUBLIC_GA_MEASUREMENT_ID` pass. Re-run `npm run check:env` to confirm (**unverified until run**, the helper `scripts/lib/env-names.mjs` was not read).
- `scripts/check-bundle-secrets.mjs` scans `.next/static` for server-only names/values; the measurement id is not a server secret, so it passes. Add a unit test proving the id is deliberately inlined and that no server-only variable name appears.
- `netlify.toml`: deploy-preview and branch-deploy contexts get no analytics vars (flag defaults to false). Production context in the Netlify dashboard (documented in `docs/DEPLOYMENT.md` list) gets `NEXT_PUBLIC_ENABLE_ANALYTICS=true` and the id only at launch step R4. Because `NEXT_PUBLIC_*` are baked in at build time, flipping the flag requires a redeploy (this is the "off switch" cost; see section 8.3 for a runtime kill switch).

### 4.5 `isAnalyticsActive()` (pure, in `config.ts`)

Active only when ALL hold:

1. `NEXT_PUBLIC_ENABLE_ANALYTICS === true`
2. a valid `NEXT_PUBLIC_GA_MEASUREMENT_ID` is present
3. `window.location.hostname === "opsdesk.sitelaunch.dev"` (exact production hostname; derived from `PRODUCTION_ORIGIN` in `src/lib/env/schema.ts`), which excludes localhost, Netlify previews (`*.netlify.app`), branch deploys, and any other host. `CONTEXT` is inlined by `next.config.ts` (`env: { CONTEXT }`) so use `process.env.CONTEXT === "production"` as the first check and the hostname as the second.
4. consent is `granted`
5. not `navigator.globalPrivacyControl === true`, not `navigator.doNotTrack === "1"` (also `window.doNotTrack`), treated as denial and the banner is not shown (or shown as "your browser asked us not to track you")
6. not `NODE_ENV === "test"` and not Playwright-controlled unless a test-only override hook is set (see section 7, uses a build-time test measurement id plus request interception; the "active" override is a documented test-only env, never set in Netlify)
7. internal traffic: a visitor can opt themselves out by visiting `/?analytics=off`... **no**: query strings are banned in tracking, and a route would be a new surface. Instead use local-storage key `opsdesk-analytics-internal=1` (set from the browser console by the owner) which makes the app send `traffic_type: "internal"` (allowlisted as a global enum param) so the GA4 "Internal traffic" data filter (section 6) can exclude it; plus an IP-based rule in GA for the owner's home IP. When `opsdesk-analytics-internal=1` is set, the simplest option is to not activate at all; both is defense in depth.

### 4.6 SPA route changes

Because `send_page_view: false`, the provider sends `page_view` itself in an effect keyed on `usePathname()`: compute `routeTemplate(pathname)`; if null (route not allowlisted), do nothing; else `track("page_view", {...})`. Deduplicate consecutive identical pathnames (React strict mode double effects in dev are irrelevant since the dev host is inactive, but keep a ref guard anyway). Under Next's App Router, `usePathname` updates on client navigations. The stream's enhanced measurement "Page changes based on browser history events" must be off (section 6) or GA would also send raw-URL page views. **Residual risk:** if the owner forgets to switch it off, raw URLs are sent. Mitigation: the CSP-independent unit test cannot see GA settings, so DebugView verification (section 7.5) includes "confirm exactly one `page_view` per navigation and its `page_location` is templated".

### 4.7 Cookies and the `/app` guest area

Cookie scope is the whole host, so a visitor who accepted on the marketing page keeps `_ga` while in `/app` as a real account; Google tag is simply not loaded there, so no collection. `_ga` remains in the browser until it expires or the user clears it. Copy says so ("Analytics is never loaded for signed-in real accounts"). Consent withdrawal: remove `_ga*` cookies with `document.cookie` expiry for names `_ga` and `_ga_<ID>` on the host and the registrable domain **(sitelaunch.dev?, verify; GA may set the cookie on `.sitelaunch.dev`, which is shared with the owner's other sites, so the cookie domain should be pinned: `cookie_domain: "opsdesk.sitelaunch.dev"` to avoid sharing the `_ga` cookie with other `*.sitelaunch.dev` properties)**. This is an important point: the default `cookie_domain: auto` sets the cookie on the highest-level domain it can, which would be `sitelaunch.dev` and span the owner's other apps. Pin it.

---

## 5. CSP and headers

State today: no security headers exist (`netlify.toml` and `next.config.ts` carry none; `docs/PROGRESS.md` SIT-272 finding). The future CSP (SIT-272) must be built with GA in mind. Analytics-related allowances (only valid when analytics is enabled; the header should be generated from the same flag so a flag-off build does not allow Google at all):

| Directive     | Allow for GA4 (when flag on)                                                                                                                           | Other sources already needed (from `docs/DEMO.md` and `src/lib/supabase`)                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `script-src`  | `https://www.googletagmanager.com`                                                                                                                     | `'self'`, `https://challenges.cloudflare.com` (Turnstile), Next runtime scripts (nonce or hash, see below)                                                                    |
| `connect-src` | `https://www.google-analytics.com` `https://*.google-analytics.com` `https://*.analytics.google.com` `https://*.googletagmanager.com`                  | `'self'`, the Supabase project URL (`https://<ref>.supabase.co`) and its `wss://` realtime if used (unverified whether realtime is used), `https://challenges.cloudflare.com` |
| `img-src`     | `https://www.google-analytics.com` `https://*.google-analytics.com` `https://*.googletagmanager.com` (collect beacons can fall back to image requests) | `'self'` `data:` `blob:`                                                                                                                                                      |
| `frame-src`   | none needed for GA4 (GTM preview/debug may need `https://www.googletagmanager.com` for the debug iframe: not needed in prod)                           | `https://challenges.cloudflare.com` (Turnstile iframe)                                                                                                                        |
| `style-src`   | none                                                                                                                                                   | `'self'` plus whatever Tailwind/Next needs (`'unsafe-inline'` or nonce for style: unverified)                                                                                 |

Regional collection endpoints: GA4 may send hits to region-specific `https://region1.google-analytics.com`, which `*.google-analytics.com` covers; **verify** against Google's "Content Security Policy" guidance for the Google tag (developers.google.com/tag-platform/security/guides/csp).

Interaction notes:

- Turnstile and GA are independent; both only add allowlist entries. The demo page (`/demo`) loads Turnstile (`turnstile-field.tsx`) and, after consent, gtag; neither requires `'unsafe-inline'`.
- Supabase: `connect-src` must list the project URL; unaffected by GA.
- **Nonce vs `'unsafe-inline'`:** Next.js's own inline bootstrap scripts need either per-request nonces (which force dynamic rendering of pages and conflict with statically prerendered marketing pages under Cache Components; Next docs describe a proxy-generated nonce, **verify its Next 16 and PPR/Cache Components behaviour**) or hash-based `script-src` or `'unsafe-inline'`. That is a SIT-272 decision. The analytics design above is neutral: it has no inline script of its own (the `gtag()` shim is bundled JS), so it works with any of the three. This is a deliberate reason to avoid `@next/third-parties`' inline init snippet. Do not add `'unsafe-eval'`.
- Add the CSP via `netlify.toml` `[[headers]]` or `next.config.ts` `headers()` or `src/proxy.ts` (which already sets cache/robots headers per response). Choose in SIT-272. If via static `[[headers]]`, the GA allowances must be present only for the production context, because the flag is off elsewhere; prefer generating the header in code from the flag.
- Roll out CSP first as `Content-Security-Policy-Report-Only`, watch the browser console in a real browser (the PROGRESS note says "a CSP can break Next.js inline scripts and Turnstile").
- Other headers unaffected: `Referrer-Policy: strict-origin-when-cross-origin` is compatible (GA gets the origin only). `Permissions-Policy` should keep `interest-cohort=()`/browsing-topics off (`browsing-topics=()`), defense against FLoC/Topics, optional.

---

## 6. GA4 property configuration checklist (owner steps in the Google Analytics UI)

Menu names change; **verify each against the current UI**.

1. Create a Google Analytics account (or use an existing one) and a **GA4 property** "OpsDesk (production)". Time zone and currency: owner's. Industry/size: any. Do **not** link Google Ads, Search Console optional (SC is fine, no personal data).
2. Create a **Web data stream** for `https://opsdesk.sitelaunch.dev` (stream name "OpsDesk production"). Copy the **Measurement ID** (`G-XXXXXXXXXX`); it goes in the Netlify production env var `NEXT_PUBLIC_GA_MEASUREMENT_ID` (not a secret).
3. Admin > Data collection and modification > **Data collection**: **Google signals data collection = off.** Also review "Granular location and device data collection" (off for fewer data) and "Advertising reporting features"/"Ads personalization" (off).
4. Admin > **Data retention**: event data retention = **2 months or 14 months** (owner decision; the only two options for standard properties); "Reset user data on new activity" per choice. Record the choice in `docs/DEPLOYMENT.md` and fill the placeholder in the privacy copy.
5. Admin > Data streams > the stream > **Enhanced measurement**: leave Page views on **but turn off "Page changes based on browser history events"** (we send our own), turn **off** "Site search" (would read query terms), **off** "Form interactions" (could read form field names/values attributes), **off** "Outbound clicks" (leaks destination URLs; we have `cta_click` for the repo link), **off** "File downloads" and "Video engagement", keep "Scrolls" optional (harmless; off to reduce noise). In the "Page views" advanced settings, check "Capture page query string"? Not available as a toggle in GA4 for query params; instead exclude query parameters via Admin > Data stream > Configure tag settings > "Define internal traffic"/"List unwanted referrals" and **Redact data** (Data collection and modification > Data redaction: enable **email addresses** and **query parameter** redaction (add `token`, `code`, `email`, `access_token`, `refresh_token`, `type`) as defense in depth; **verify availability**).
6. Admin > Data streams > stream > **Configure tag settings**: **List unwanted referrals**: add `challenges.cloudflare.com` (Turnstile redirect/cross-domain), `github.com` is a genuine referrer (keep). **Define internal traffic**: add a rule for the owner's IP(s) (`traffic_type = internal`) and a second rule `traffic_type` equals `internal` from the app's own param. Then Admin > **Data filters** > "Internal Traffic" filter: set to **Testing** first, verify in DebugView/Reports, then **Active**.
7. Admin > Data collection > **Data sharing settings**: untick Google products & services sharing, Benchmarking, Technical support and Account specialists (all optional; off is the conservative choice). Accept the **Data Processing Terms** (Admin > Account settings) and the data-protection terms (EU).
8. Admin > **Key events**: mark `demo_start`, `demo_bootstrap_success`, `first_customer_created`, `first_stage_move`, `quote_created`, `demo_journey_completed`, `sign_up`. They appear only after the event has been received once, so mark them after the first DebugView session.
9. Admin > **Custom definitions** > Custom dimensions (all **event-scoped**; free properties are limited to 50 event-scoped and 25 user-scoped custom dimensions, **verify**): `cta_id`, `placement`, `source`, `reason`, `error_area`, `error_code`, `from_stage`, `to_stage`, `entity`, `app_area`, `row_count_bucket`, `duration_bucket`, `page_path_template`. Not registered: `request_id` (high cardinality; look it up in DebugView or BigQuery export, if wanted register it as event-scoped knowing the "(other)" cardinality issue). No user-scoped dimensions. Custom metrics: none.
10. Admin > Data collection > **User-ID**: leave unconfigured. Admin > Reporting identity: choose **Device-based** (no User-ID/signals).
11. Admin > Access management: owner only as Administrator; no wide sharing; enable 2-step verification on the Google account.
12. Verify with **DebugView** (Admin > DebugView) while the site is run with `debug_mode: true` (set via the `?debug` mechanism? no, query strings are banned: use the Google Analytics Debugger Chrome extension or pass `debug_mode` through a `localStorage` flag `opsdesk-analytics-debug=1` read by `gtag.ts`). Then check **Realtime** for `page_view`, `demo_start`, and so on, and that `page_location` has no query string.
13. After 24-48 hours of data, build the funnel exploration (section 3.3) and save it. Optionally set Admin > Data streams > **Event create/modify** to nothing (no event rewrite needed).
14. Calendar a quarterly review: retention, access, filters Active, no "(not set)" PII in dimensions.

---

## 7. Testing and verification

### 7.1 Unit tests (Vitest, `npm run test:unit`)

- `src/lib/analytics/sanitize.test.ts`:
  - unknown event name dropped; unknown param key dropped; wrong-typed enum dropped; no throw on `undefined`, circular objects, huge strings.
  - **Fuzz test**: for every allowlisted event and param key, inject values from a generator set (emails `a@b.co`, `a+tag@sub.example.com`, uuids v4 upper and lower case, `eyJ...` JWTs, 41-char opaque tokens, 500-char text, strings with `?`, `#`, `&token=...`, URLs with query strings, unicode, names like "Acme Corp"), plus 500 random seeded strings (use a seeded PRNG for reproducibility); assert the sanitized output contains none of them and never contains a value matching email/uuid/JWT/length regexes. Property: `for all outputs, JSON.stringify(output)` does not match any banned regex.
  - forbidden keys (`user_id`, `user_properties`, `email`, `customer_name`, `workspace_id`, `search_term`) dropped even when someone adds them to an event definition by mistake (a test over the `EVENTS` table itself asserts no key matches the forbidden regexes, so adding one fails CI).
- `route-template.test.ts`: every real `/app/...` path and `/demo`, `/` map to templates; uuid and numeric segments become `[id]`; `/reset-password`, `/invite/abc`, `/auth/callback`, unknown paths return null; query strings and hashes stripped.
- `config.test.ts`: truth table for flag, id, hostname, consent, GPC, DNT, test env, internal key (every single missing condition makes it inactive).
- `consent.test.ts`: storage throws -> denied; expired record -> ask again; GPC true -> denied.
- `src/lib/env/schema.test.ts` additions: flag default false, id regex, production + flag + no id fails, empty strings count as unset (existing pattern).
- Legal copy: update `src/app/(marketing)/legal-pages.test.tsx` to assert the new analytics wording (mentions consent, Google Analytics 4, `_ga`, retention, "never loaded for signed-in real accounts") and that it **no longer** says "No analytics are collected today". Add a **drift test**: reads `.env.example` and the netlify config and fails if `NEXT_PUBLIC_ENABLE_ANALYTICS` is `true` there (default must stay false in the repo). The `netlify-config.test.ts` already exists in `src/lib` and is the model.
- A grep-style test (like `src/lib/api-client/lint-rules.test.ts`, `src/features/quotes/no-outbound.test.ts`) that fails if any file outside `src/lib/analytics` and `src/components/analytics` references `gtag`, `dataLayer`, `googletagmanager` or `google-analytics`, so every call goes through `track()`.
- Component tests: banner defaults, Decline equal prominence, keyboard operation, focus.

### 7.2 Playwright (`e2e/analytics.spec.ts`, new)

How the suite runs today: `npm run test:e2e` runs `scripts/e2e.mjs`, which builds with `NEXT_DIST_DIR=.next-e2e` and local Supabase, then `playwright test` against `next start` on port 3111 (`playwright.config.ts`, 1 worker, desktop and mobile projects). The build bakes `NEXT_PUBLIC_*` values, so analytics tests need a build where the flag and a **fake** id (`G-TESTFAKE00`) are set. Plan: add `NEXT_PUBLIC_ENABLE_ANALYTICS` and `NEXT_PUBLIC_GA_MEASUREMENT_ID` to the env object in `scripts/e2e.mjs` only if the whole suite should run with analytics compiled in. Because of the hostname rule (4.5 item 3), the hostname gate must be overridable in e2e: add a test-only `NEXT_PUBLIC_ANALYTICS_HOST_OVERRIDE` is **not** wanted (it would ship a bypass). Alternative: a hostname _allowlist_ in the code derived from `NEXT_PUBLIC_APP_URL` (in e2e it is `http://localhost:3111`): active host = hostname of `NEXT_PUBLIC_APP_URL`; production sets APP_URL to `https://opsdesk.sitelaunch.dev` (already required by `PRODUCTION_ORIGIN` check). Then local dev has `localhost:3000` as APP_URL, so dev would be active too, therefore also require `NEXT_PUBLIC_ENABLE_ANALYTICS` true, which defaults false and is only true in the e2e build and production. That is the recommended gate: flag + id + host equals APP_URL host + consent. Preview deploys have a different host than APP_URL, so they stay inactive (verify that previews do not set APP_URL to their own URL: `netlify.toml` previews do not set APP_URL, so it is the production value or unset: **unverified**).

Tests (the project config uses `use.baseURL` so `page.route` interception works):

1. **Flag off** (separate build or project `analytics-off`; or use an `?` free approach: run this spec file in a second invocation with the flag unset): load `/`, `/demo`, `/privacy`; collect all requests via `page.on("request")`; assert zero requests to hosts matching `googletagmanager.com|google-analytics.com|analytics.google.com|doubleclick.net`; assert no `_ga` cookie; assert no consent banner is rendered when flag is off.
2. **Flag on, no consent**: banner visible; zero Google requests; no cookies; clicking Decline stores `denied` and still zero requests; reload keeps denied.
3. **Flag on, consent granted** (click Accept): `page.route("**/googletagmanager.com/**", route => route.fulfill({ status: 200, contentType: "application/javascript", body: STUB_GTAG }))` where the stub defines nothing harmful (or sets `window.__events`), and `page.route("**/*google-analytics.com/**", r => r.fulfill({status: 204}))` and record request URLs/post bodies. **Never reach real Google** (also add `page.route` catch-all `abort` for those hosts first, and a final assertion that no request escaped the stubs; run e2e with network blocked to those hosts is not possible, so rely on route handlers registered at context level, `context.route`). Click "Try Live Demo" -> assert the sequence `cta_click`, `demo_start`, `demo_bootstrap_success` via the recorded dataLayer (`page.evaluate(() => window.dataLayer)`), and that every recorded param key is in the allowlist and no value matches email/uuid/query-string regexes. Drive the existing guest journey helpers (`e2e/support/local.ts`, `e2e/journey.spec.ts`) to create a customer, move a stage, create a quote and assert `first_customer_created`, `first_stage_move`, `quote_created`, `demo_journey_completed` fire once each and `page_location` is templated (`/app/customers/[id]`).
4. **/app policy**: guest in `/app`: events fire (only anonymous ones). Real account (sign up with email via the existing helpers): assert **no** gtag script element, no Google request, `window.gtag` undefined, and `window.dataLayer` undefined or empty, on `/app` pages, and that creating a customer fires nothing. Also assert `/reset-password` and `/invite/...` never load gtag even with consent granted.
5. **GPC/DNT**: `context` with `extraHTTPHeaders` can't set navigator flags; use `page.addInitScript(() => Object.defineProperty(navigator, "globalPrivacyControl", { value: true }))`; assert inactive even after "granted" in storage.
6. **Blocked script**: `context.route("**/googletagmanager.com/**", r => r.abort())` (simulates an ad blocker); run the whole demo journey: no uncaught page error (`page.on("pageerror")` fails the test), no console errors from our code, UI actions still succeed, `track()` returns without throwing.
7. **Non-production host**: covered by the unit truth table; in e2e the second server hostname (`127.0.0.1:3111` vs `localhost:3111`) hits the host check and stays inactive; assert it.
8. **Existing e2e log scan** (`scripts/e2e.mjs` then `scripts/lib/log-scan.mjs`, `scripts/scan-logs.mjs`, tested by `src/lib/logger/log-scan.test.ts`): it scans the combined stdout/stderr of the whole run (including the app server's JSON log lines). Analytics adds no server logging, so it should be unaffected. Danger: a test that prints `window.dataLayer` contents or request URLs to stdout would feed the scanner; keep fake data in tests free of emails (the fake events contain none by design, and the scanner flags emails). Do not `console.log` captured payloads. Also the scan rules might flag a GA-style id: **(unverified, run once and read the findings)**.
9. Existing specs `e2e/accessibility.spec.ts`, `e2e/lighthouse.spec.ts`, `e2e/performance.spec.ts`: the banner must not break axe checks (contrast, focus order) nor Lighthouse/performance budgets; with the flag off in those runs it does not render. Add a run with the banner visible to the accessibility spec for the landing page.

### 7.3 Mutation-style checks (pattern: `scripts/mutation-*.mjs`)

Add `scripts/mutation-analytics.mjs` (same pattern as `mutation-security.mjs`, which I did not read; **unverified**): apply a deliberate break, run the specific tests, require a failure, restore. Mutations:

1. Remove one key from the forbidden regex / add `email` to an event's allowed keys -> sanitizer test fails.
2. Make `isAnalyticsActive` ignore consent -> Playwright "no consent" test and config truth table fail.
3. Make the guest provider render for non-anonymous users -> the real-account /app test fails.
4. Remove the hostname check -> host test fails.
5. Make `route-template` return raw pathname -> templated-path test fails.
6. Flip flag default to true -> env schema test and drift test fail.
7. Make `track()` buffer pre-consent events -> pre-consent test fails.
8. Remove the privacy-page analytics wording or restore "No analytics are collected today" -> copy test fails.

### 7.4 Gate

`npm run check` and `npm run test` (via `scripts/run-steps.mjs`) must stay green; add the new unit tests to the existing run (no step file change expected, Vitest picks them up; the e2e analytics spec is added to the full `npm run test:e2e`, not to `test:e2e:scenarios*` scripts unless wanted). `docs/TEST_MAP.md` gets a row.

### 7.5 Real-world verification (owner steps, after the Netlify deploy and CSP)

1. Deploy production with the flag on; open the site in a clean browser profile; confirm banner; Decline -> Network tab shows no Google requests.
2. Accept; confirm requests to `www.googletagmanager.com/gtag/js` and `*.google-analytics.com/g/collect` succeed (no CSP violations in the console).
3. In GA4 DebugView/Realtime: see `page_view` (templated `page_location`, no query string), `cta_click`, `demo_start`.
4. Run through the demo journey as a guest and see the key events once each.
5. Sign in with a real account: confirm no Google requests in `/app`.
6. Test with an ad blocker (uBlock Origin): site fully works, no console errors.
7. Test `Sec-GPC: 1` browser (Firefox with GPC, Brave): inactive.
8. After 24-48 hours check the Data filters (internal traffic Active), key events and custom dimensions populated, and the funnel.

---

## 8. Rollout and risks

### 8.1 Phased tasks (each issue-sized; all under **SIT-146** as sub-issues of P-03, labels per `docs/PROGRESS.md` convention; Linear issues cannot be created from here and should be created by the owner or in a Linear session)

| #     | Task                                                                                                                                                                                                                              | Acceptance criteria                                                                                                                                       | Depends on                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P-03a | Env and flag: add `NEXT_PUBLIC_ENABLE_ANALYTICS` (default false) and `NEXT_PUBLIC_GA_MEASUREMENT_ID`, `.env.example`, `public.ts`, schema tests                                                                                   | schema tests pass; `npm run check:env` and `check:bundle` pass; flag default false; production+flag+no id is an `EnvError`                                | none                                         |
| P-03b | `src/lib/analytics`: events allowlist, sanitizer, route templates, config, consent, `track()`; unit tests incl. fuzz                                                                                                              | all unit tests in 7.1 pass; `EVENTS` table forbidden-key test; grep test that nothing else touches `gtag`; coverage of the module at the repo's threshold | P-03a                                        |
| P-03c | Consent banner, `AnalyticsProvider` for public and auth routes, footer "Analytics preferences" link; flag off renders nothing                                                                                                     | with flag off no banner and no network; with flag on and no consent zero Google requests; banner accessible (axe clean); GPC/DNT respected                | P-03b                                        |
| P-03d | Copy: privacy and terms wording (section 2.2), update `legal-pages.test.tsx`, `docs/DECISIONS.md` (new row superseding P-03 won't-do), `docs/PROGRESS.md`, `docs/DEPLOYMENT.md` retention and env docs                            | tests assert new wording and absence of "No analytics are collected today"; docs say what is true; copy shipped in the same release as flag               | P-03b (copy must be ready before enabling)   |
| P-03e | Guest demo events: instrument `demo-entry-client`, customers, opportunities (`use-move-stage.ts`), tasks (`use-complete-task.ts`), quotes, exports, reset, expired, error panels; guest-only provider in `src/app/app/layout.tsx` | e2e tests 3 and 4 pass; real-account /app has no gtag; every param validated by sanitizer; logs scan clean                                                | P-03c                                        |
| P-03f | CSP allowances (part of SIT-272 security headers): `script-src`, `connect-src`, `img-src` for Google only when the flag is on; Report-Only first                                                                                  | real-browser check shows no violations with analytics on and Turnstile and Supabase working; flag-off build allows no Google host                         | SIT-272 (needs SIT-177 site, SIT-213)        |
| P-03g | `scripts/mutation-analytics.mjs` and e2e `analytics.spec.ts` (all 9 cases in 7.2), TEST_MAP row                                                                                                                                   | all mutations killed; e2e green with the log scan clean                                                                                                   | P-03c, P-03e                                 |
| P-03h | **Owner**: GA4 property configuration (section 6) and DebugView verification (7.5)                                                                                                                                                | checklist in section 6 ticked; DebugView shows templated paths and no PII                                                                                 | Netlify production site (SIT-177/272), P-03f |
| P-03i | Enable in production: set the two Netlify production vars, redeploy, verify (7.5), record in `docs/DEPLOYMENT.md`                                                                                                                 | steps 1-8 of 7.5 pass; privacy copy live in the same deploy                                                                                               | P-03d, P-03f, P-03h                          |

Implementation (a to e, g) can be built and merged with the flag off before the Netlify site exists; nothing reaches Google until P-03i. This also keeps CI e2e (P-12, SIT-274) independent.

### 8.2 Dependencies on the Netlify site and CSP

- A real measurement id needs the GA property (owner) but not the Netlify site; enabling requires the production hostname to exist (SIT-177/272, P-13 custom domain) because the stream URL and the host check are `opsdesk.sitelaunch.dev`.
- CSP (SIT-272) is a hard prerequisite for P-03i only if the CSP lands first; if analytics lands first with no CSP, it works, and the CSP author must then include section 5's allowances, so add a line to SIT-272's description.
- Env vars live in the Netlify dashboard per `docs/DEPLOYMENT.md`; add the two variables to that list.

### 8.3 Turning it off quickly

1. Fast (minutes, no code): set `NEXT_PUBLIC_ENABLE_ANALYTICS=false` in Netlify production and redeploy (compile-time inlined, so a rebuild is required, about the cost of one Netlify build).
2. Instant (no redeploy): in GA4 disable the data stream (Admin > Data streams > stream > "Turn off data collection"? **verify**) or apply a "Developer traffic" style data filter. Data stops being recorded, but the browser still sends hits, so use 1 as well.
3. Optional runtime kill switch: a tiny `/analytics-config.json` static file consulted before loading gtag (adds a request and complexity; not included in v1 unless wanted).
4. Rollback of the CSP allowances is independent.
5. After disabling, the privacy copy must be updated to say analytics is off (the drift test in 7.1 enforces agreement in the repo, not in the running site).

### 8.4 Risks

| Risk                                                                                                              | Likelihood | Impact | Mitigation                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consent compliance wrong for EU/UK/US states                                                                      | Medium     | High   | Strict opt-in everywhere, GPC/DNT honored, equal Decline, copy matches behaviour (test), owner confirms with counsel (2.3)                                                                   |
| Ad-blocker / privacy-browser data loss (technical audience blocks GA often)                                       | High       | Medium | Accept: numbers are directional only; state that in the privacy/README; fallback to Plausible/Umami adapter; `track()` never breaks the app when blocked (test 7.2 case 6)                   |
| Accidental PII reaches GA                                                                                         | Low-Med    | High   | Allowlist + value screen + forbidden keys + fuzz + mutation tests + templated URLs + GA data redaction + guest-only in `/app` + no `/reset-password`/`/invite`                               |
| Raw URL leak via enhanced measurement history events left on in GA                                                | Medium     | High   | `send_page_view:false`, owner checklist step 5, DebugView check of `page_location`; query-parameter redaction in GA as backstop                                                              |
| CSP breaks analytics or breaks Next/Turnstile when CSP lands                                                      | Medium     | Medium | Report-Only first, real-browser check, analytics has no inline script, flag-gated header                                                                                                     |
| Demo traffic skews numbers (bots, owner's own testing, prospects who bounce, a 24h demo that people re-bootstrap) | High       | Low    | Internal-traffic filter and `traffic_type`, only count key events once per session, Turnstile already filters most bots, interpret demo_start vs bootstrap_success separately, `retry` param |
| GA blocked or unavailable in some countries (e.g. China) and in corporate networks                                | Medium     | Low    | Accept; analytics is best-effort; never block UI on it                                                                                                                                       |
| Cookie lifetime / shared domain (`.sitelaunch.dev` cookie spans owner's other sites)                              | Medium     | Medium | Pin `cookie_domain` to the exact host and set `cookie_expires` shorter (4.2, 4.7); copy states the true lifetime                                                                             |
| Privacy page drifts from behaviour after future changes                                                           | Medium     | Medium | Copy tests, drift test on flag defaults, `docs/DECISIONS.md` row, owner checklist                                                                                                            |
| Banner hurts performance/accessibility scores (Lighthouse, axe)                                                   | Low        | Low    | Small fixed bar, no layout shift, a11y tests with banner visible                                                                                                                             |
| Real account upgrade from guest keeps `_ga` cookie / sends last events                                            | Low        | Low    | Provider only mounts for anonymous users; cookie remains but nothing is sent; copy says so                                                                                                   |
| Google changes GA4 settings/legal (e.g. retention, UI names)                                                      | Medium     | Low    | Section 10 lists what to re-verify; quarterly review (6.14)                                                                                                                                  |

---

## 9. Final checklist

Code and docs (engineering):

- [ ] P-03a env and flag (`src/lib/env/schema.ts`, `public.ts`, `.env.example`), `check:env` and `check:bundle` green
- [ ] P-03b `src/lib/analytics` with allowlist, sanitizer, route templates, config, consent, `track()`; fuzz tests
- [ ] P-03c consent banner and providers; flag off renders nothing and sends nothing
- [ ] P-03d privacy and terms copy; `legal-pages.test.tsx` updated; `docs/DECISIONS.md` and `docs/PROGRESS.md` updated; contact route for privacy requests decided
- [ ] P-03e events wired in demo entry, customers, opportunities, tasks, quotes, exports, reset, expired, errors; guest-only provider in `src/app/app/layout.tsx`; real accounts never loaded
- [ ] P-03f CSP allowances added to SIT-272 (script/connect/img), Report-Only first
- [ ] P-03g Playwright `analytics.spec.ts` (9 cases) and `scripts/mutation-analytics.mjs`; e2e log scan clean; `docs/TEST_MAP.md` updated
- [ ] `npm run check` and `npm run test` green

Owner (you):

- [ ] Confirm legal points in 2.3 with counsel or accept the risk consciously (controller/contact, DPA, GPC)
- [ ] Decide retention (2 or 14 months) and fill the copy
- [ ] P-03h GA4 property configuration (section 6), DebugView verification
- [ ] Netlify production env vars and redeploy (P-03i); verify (7.5)
- [ ] Add a line to SIT-272 about the GA CSP allowances

---

## 10. Facts I could not verify (re-check before relying on them)

- GA4 retention options (2 or 14 months for standard properties), default value and menu path.
- "GA4 does not log or store IP addresses" and the absence of an IP-anonymization toggle.
- `_ga` / `_ga_<id>` cookie default lifetime (2 years), and the gtag config keys `cookie_expires`, `cookie_domain`, `cookie_flags`, `send_page_view`, `allow_google_signals`, `allow_ad_personalization_signals`, `page_location` override behaviour via `gtag("set")`.
- Whether Consent Mode v2 "denied" still sends cookieless pings, and the exact parameter set (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`).
- `@next/third-parties/google` `GoogleAnalytics` props (`gaId`, `dataLayerName`, `nonce`, `debugMode`), its page-view handling, and compatibility with Next 16.4.3.
- Exact CSP host list for GA4 including regional endpoints (Google "CSP for the Google tag" guidance).
- GA4 custom dimension limits (50 event-scoped, 25 user-scoped on standard properties) and event/parameter limits (500 distinct events, 25 params/event, 100 char values).
- Availability and menu names of Data redaction, data filters, internal traffic, reporting identity, key events.
- Legal: whether GDPR, UK PECR or any US state law applies to this site as run by an individual; EU-US Data Privacy Framework status for Google; GPC legal obligations by state.
- In the repo: contents of `src/app/(auth)/layout.tsx`, `scripts/lib/env-names.mjs`, `scripts/lib/log-scan.mjs`, `scripts/mutation-security.mjs`, the request-id format, whether Supabase realtime (`wss:`) is used, whether a guest-to-real-account upgrade flow exists, exact component file names under `src/features/*/components/` for the create/send/PDF actions, and whether Netlify previews set `NEXT_PUBLIC_APP_URL`.
- Nothing in this plan has been built, run or tested.
