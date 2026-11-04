# Architecture

How OpsDesk is built, as it exists now. Sections below are by topic and carry the issue that introduced them.

## System overview

- **Runtime:** Next.js 16 (App Router, Cache Components) with React 19, TypeScript strict, Tailwind v4 and shadcn/ui. Server components render the shell per request; client components use TanStack Query through `useApiQuery` / `useApiMutation`. Netlify hosts it (not deployed yet, see `docs/DEPLOYMENT.md`).
- **Data:** Supabase. Postgres holds every tenant table with row level security; Supabase Auth holds users (including anonymous guests for the public demo). The browser never talks to Postgres: pages and `/api/v1` route handlers act as the signed-in user with a cookie session, so RLS decides what a request can see and change. The secret key exists only in `src/lib/supabase/admin.ts` and is used by the demo cleanup and a few guarded operations.
- **Request path:** `proxy.ts` refreshes the session and guards `/app`; route handlers are wrapped by `withApi` / `withOrgApi` (`src/lib/api/handler.ts`), which resolve the user, check the Origin on mutations, resolve the workspace from `X-Organization-Id`, authorize the action against the permission matrix, validate the body with Zod, and return the `{ data, meta }` / `{ error }` envelope with a request id. One `api.request` JSON log line is written per call.
- **Tenancy:** every tenant table has `organization_id` and the same policies from `private.attach_tenant_rls`; roles (owner, admin, member, viewer) live in `memberships`; a demo workspace is an organization of kind `demo` with an `expires_at`. Cross-tenant foreign keys are blocked by composite keys and triggers.
- **Rules in the database:** totals and activity events are written by triggers and definer functions, not by the client; edits use a version column (`STALE_EDIT` 409); quote math is integer cents and identical in the browser and in the database.
- **Demo:** an anonymous Supabase session per visitor (Turnstile-protected), one fictional workspace each, 24-hour expiry, caps, reset, and a two-phase cleanup run by a Netlify scheduled function or `npm run demo:cleanup`.
- **Quality gates:** unit, pgTAP, API integration (real HTTP) and Playwright suites, axe in both themes, Lighthouse and performance audits, and a log scan over the end-to-end run; see `docs/TEST_MAP.md`, `docs/CI.md` and `docs/PROGRESS.md` for what each covers and the measured results.
- **Not built:** the P2 integrations (attachments, billing, e-mail, AI, external connector); their routes return 404 while their flags are off.

## Design tokens (SIT-159)

Defined as CSS variables in `src/app/globals.css` (`:root` for light, `.dark` for dark) and exposed to Tailwind through `@theme inline`. Tokens are plain hex so `src/lib/design/contrast.test.ts` can verify WCAG 2.2 AA on every change.

- **Palette:** warm-neutral base (paper `#fafaf9`, ink `#1c1b1a`, border `#e2e0dc`) with one brand accent, teal (`--primary`: `#0f6b63` light, `#4cc3b4` dark).
- **Status colors:** `success`, `warning`, `info`, `destructive`, each with a `-foreground` and a `-subtle` background token. Never use color as the only signal: pair with an icon or text (PRD 3.2).
- **Control borders:** `--input` is darker than `--border` to meet 3:1 for form controls.
- **Typeface:** IBM Plex Sans (UI) and IBM Plex Mono (code), loaded with `next/font`. Tables use tabular numerals.
- **Theme:** `next-themes` with `attribute="class"`, default `light`, options Light, Dark, System, stored in `localStorage` under `opsdesk-theme`. Its inline script runs before the page content paints, so there is no flash. `ThemeToggle` (`src/components/layout/theme-toggle.tsx`) cycles Light, Dark, System and goes in the app shell top bar.
- **Focus:** primitives use a solid 3px `--ring` ring; a global `:focus-visible` outline covers anything else. Reduced motion is respected globally.
- **Primitives (shadcn/ui, Radix base):** button, input, label, select, dialog, sheet, drawer, dropdown-menu, table, tabs, sonner (toast), skeleton, badge. Icons: lucide-react.

## App shell (SIT-162)

`src/components/layout/app-shell.tsx` hosts every `/app/*` page. `src/app/app/layout.tsx` renders it for the `/app` segment.

- **Desktop (md and up):** fixed 240px sidebar, compact 48px top bar (workspace selector slot, search, theme toggle, account menu). **Below md:** the sidebar becomes a left drawer (Radix dialog via `Sheet`), opened from a menu button in the top bar; Escape closes it and focus returns to the button; choosing a link closes it.
- **Landmarks and keyboard:** a skip link is the first focusable element and moves focus to `<main id="main-content" tabindex="-1">`; `header`, `nav` ("Main"), `main`. The current section carries `aria-current="page"`.
- **Nav config** (`nav-config.ts`): icons are referenced by name (components cannot cross the server/client boundary). `BUILT_ROUTES` lists the pages that exist; items for pages that do not exist yet are not rendered. Each issue that adds a page appends its href there, and a test checks each has a page file. Quotes follows `NEXT_PUBLIC_ENABLE_QUOTES`.
- **Slots:** `orgSelector`, `user`, and `banner` props render fine without data; the workspace issues (SIT-209) and guest banner (SIT-211) fill them.
- **Rendering:** the layout calls `connection()` inside `Suspense`, so the authenticated shell is rendered per request and never prerendered (`cacheComponents` rejects `export const dynamic`).

## Route map (SIT-176)

`src/lib/routes.ts` lists every PRD 3.3 route and drives the route unit test, the nav test, and `npm run smoke:routes` (hits a running server). Route groups follow PRD 10: `(marketing)` for `/`, `/privacy`, `/terms`; `(auth)` for `/demo`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/auth/callback`; `app/` for everything under `/app`.

- **Caching:** `/`, `/privacy`, `/terms` are static (`s-maxage=31536000`). Auth pages and everything under `/app` render per request (`connection()` inside `Suspense`) and send `private, no-cache, no-store`.
- **P2 flags:** `/app/settings/integrations` and `/app/settings/billing` return a real 404 while `NEXT_PUBLIC_ENABLE_INTEGRATIONS` / `NEXT_PUBLIC_ENABLE_BILLING` are off. `src/proxy.ts` rewrites them to a non-existent path, because a page-level `notFound()` would run after the shell has started streaming a 200. The settings sub-nav links them only when the flag is on.
- **Holding pages:** only the two P2 settings pages (integrations, billing) render `PlannedPage` (a title, what it will do, a link back; no fake data), and only when their flag is on. Every other route is a real page.
- **Boundaries:** `not-found.tsx` and `error.tsx` exist at the root and inside `/app` (the latter keeps the shell), built on `StatePanel` / `ErrorPanel` in `src/components/shared`.
- **Auth guard:** `/app` is protected by `src/proxy.ts` and the layout (SIT-180); a signed-out visitor is redirected to `/login`, and a guest whose demo expired to `/demo` (see `docs/SECURITY.md`, "Route protection").

## Shared state components (SIT-163)

`src/components/shared` holds the reusable states: `TableSkeleton` / `CardSkeleton` / `ChartSkeleton`, `EmptyState`, `ErrorAlert` (shows the API error envelope's request ID), `ToastProvider` + `notify` (sonner), and `ConfirmDialog` (Radix alert dialog). Usage notes are in `src/components/shared/README.md`. `StatePanel`, `PlannedPage`, and `ErrorPanel` (SIT-176) share the same layout. `ConfirmDialog` restores focus itself because Radix only returns focus to its own `Trigger`, and dialogs here are opened from any control.

## Accessibility checklist

The baseline for every screen (PRD 3.2, WCAG 2.2 AA). Feature issues reference this list in their Definition of Done; the pull request template repeats it. Shared pieces already satisfy most items, so reuse them: `FormField`, `ErrorSummary`, `ErrorAlert`, `EmptyState`, the skeletons, `ConfirmDialog`, `notify` (all in `src/components/shared`), and the tokens in `src/app/globals.css`.

**Structure**

- One `h1` per page; headings in order; landmarks `header`, `nav` (labelled when there are several), `main`, `footer`; a page `title`.
- Skip link first in tab order, targeting `main#main-content` (which has `tabIndex={-1}` so focus lands there). Every layout has one: the app shell, the marketing and legal pages, and the auth pages (login, signup, forgot and reset password, demo).

**Keyboard**

- Everything interactive is reachable and operable with the keyboard, in an order that matches the visual order. No keyboard traps.
- Focus is always visible. Never add `outline-none` without a `focus-visible` ring; ring colors are never translucent. A focused element must not hide under the sticky top bar (`scroll-padding-top` in `globals.css`).
- Dialogs trap focus, return it to the opener on close, and close on Esc unless an action is running (`ConfirmDialog` does this).
- Anything that needs dragging also has a non-drag control (the kanban board has a stage selector; WCAG 2.5.7).

**Names, labels, and forms**

- Every control has a visible label (`FormField`); helper text and errors are linked with `aria-describedby`; invalid controls set `aria-invalid`.
- A failed submit shows an `ErrorSummary` (an `alert`, so it is announced; focus goes to the first invalid field so the fix can be typed at once, and each invalid control is linked to its message with `aria-describedby`). Errors say what is wrong and how to fix it, in words.
- Icon-only buttons have an `aria-label`; decorative icons and illustrations are `aria-hidden`; informative images have alt text.
- Identity fields set `autocomplete`; login and signup never require a cognitive test and allow pasting into password fields (WCAG 3.3.8).

**Color, contrast, and status**

- Use the tokens (contrast is tested in `contrast.test.ts`). Do not hard-code colors.
- Never color alone: pair status with an icon and text ("Overdue", not just red).

**Motion**

- Animate only to show what changed. All animation and transitions are removed under `prefers-reduced-motion` by the global rule. No auto-playing or looping motion, with one exception: the skeleton shimmer for loading placeholders (it is frozen under reduced motion).
- Timing comes from tokens in `globals.css`: `--motion-fast` 120ms, `--motion-base` 180ms, `--motion-slow` 280ms, and `--ease-out`, `--ease-in-out`, `--ease-settle`. Nothing runs longer than `--motion-slow`, except the one-time KPI count-up (600ms). Animate `transform` and `opacity` only.
- JS-driven motion reads `usePrefersReducedMotion()` (`src/lib/motion/`). A row or card that just changed is marked with `markFresh(id)` (`src/lib/motion/fresh.ts`); `FreshRow`, the board card and `QuoteStatus` read `useIsFresh(id)` to flash or settle once.
- `Button` takes `pending`: it locks, shows a spinner over its label and keeps its width. Use it for every submit that waits on the network.
- Page changes use React `<ViewTransition>` through `PageTransition` (`src/components/layout/page-transition.tsx`), wrapped in each `page.tsx`, never in a layout. Links choose the direction with `transitionTypes={["nav-forward"]}` or `["nav-back"]`; a link with no type crossfades. `Morph` (`components/shared/morph.tsx`) pairs a list row's name with its detail header.

**Zoom and touch**

- The page works at 200% zoom and 320px wide with no horizontal scroll and no hidden primary actions. Touch targets are at least 24x24 CSS px (WCAG 2.5.8).

**Dynamic content**

- Loading uses a labelled skeleton (one polite status per area); results and failures are announced (`role="status"` / `role="alert"`, or a toast); async changes never move focus unexpectedly.

**Proof**

- A component test for the keyboard path and an axe check with `expectNoA11yViolations()` (`src/test/axe.ts`) in light and dark. jsdom cannot compute color contrast; the token tests and a browser check cover it.
- Before a milestone ends: a keyboard-only pass, a screen reader pass on the main journey, and Lighthouse accessibility of at least 90 on key pages (record real scores in `docs/PROGRESS.md`).
- Lint: `jsx-a11y` recommended rules run as errors (`eslint.config.mjs`) and are tested in `src/test/a11y-baseline.test.ts`.

## Supabase clients and sessions (SIT-169)

Files in `src/lib/supabase/`:

| File                      | Used from                                                          | Purpose                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.ts`               | Client Components                                                  | Browser client (publishable key). Every query runs under RLS.                                                                                                                                                                                                                               |
| `server.ts`               | Server Components, route handlers, server actions                  | Request-scoped client acting as the signed-in user (their cookies), so RLS applies. Create one per request.                                                                                                                                                                                 |
| `create-server-client.ts` | `server.ts`, tests                                                 | The cookie-bridging factory; takes any cookie jar.                                                                                                                                                                                                                                          |
| `middleware.ts`           | `src/proxy.ts`                                                     | `updateSession(request)` refreshes the session and forwards the new cookies and the no-store cache headers on the response. `needsSession(path)` limits it to `/app`, `/auth`, `/api`, and the auth pages, so the static landing and legal pages never get a Set-Cookie and stay cacheable. |
| `resolve-user.ts`         | everywhere                                                         | `resolveUser(client, jwt?)` calls `auth.getUser()`, which makes Supabase Auth verify the token (signature, expiry, user exists). Returns `{ id, email, isAnonymous }` or `null`; tampered, forged, expired, missing, or unreachable all give `null`.                                        |
| `current-user.ts`         | server only                                                        | `getCurrentUser()` = `resolveUser(await createClient())`.                                                                                                                                                                                                                                   |
| `admin.ts`                | demo cleanup, demo route handlers, Netlify functions, scripts only | Client with the secret key. It BYPASSES RLS. `server-only` makes importing it from client code a build error, and the `no-restricted-imports` rule in `eslint.config.mjs` makes importing it anywhere but those places a lint error. Never for ordinary business reads or writes.           |

**Cookies** (`cookie-options.ts`): host-scoped (no `Domain`, so `sitelaunch.dev` and other subdomains never get them), `Path=/`, `SameSite=Lax`, `Secure` whenever `NEXT_PUBLIC_APP_URL` is https (off only for http://localhost). They are **not** `HttpOnly`, deliberately: the browser client signs in anonymously and refreshes tokens, so it must read the session. This is why server code never trusts the cookie payload and always verifies with `resolveUser`. A content security policy and short token lifetimes are the compensating controls (not yet configured).

**Session refresh:** `src/proxy.ts` runs `updateSession` before rendering protected and auth routes. Server Components cannot write cookies, so the proxy is the only place a refreshed session is persisted; it also updates the request cookies so the page that renders next sees the new session.

## API layer (SIT-170)

`src/lib/api/` holds the one contract every `/api/v1` handler uses: `types.ts` (envelope types shared with the future typed client and with `ErrorAlert`), `errors.ts` (`ApiError` and its subclasses), `envelope.ts` (`okItem`, `okList`, `created`, `noContent`, and the response builders), `request-id.ts`, `json-body.ts` (content-type check, `readJson`), `postgres-errors.ts` (database error mapping and the `OD` SQLSTATE convention), `to-api-error.ts` (Zod and database conversion), and `handler.ts` (`withApi`, which logs one line per request through `src/lib/logger`). The full contract, the status table, and how to write a handler are in `docs/API.md`.

## Permissions (SIT-171)

`src/lib/permissions/`: `matrix.ts` is the PRD 5.1 matrix as typed data (a missing action or role is a type error); `can.ts` has `can`, `allowedActions`, `permissionsFor` (UI), `assertCan` (route handlers, throws the 403 envelope), `grantableRoles` and `canChangeMembership` (invitations and role changes); `docs.ts` renders the table that `docs/SECURITY.md` embeds (a test fails if they drift). The database stays the final authority.

**Verified in a real browser (SIT-261, `e2e/accessibility.spec.ts`, run by `npm run test:e2e`)**

- axe-core with the WCAG 2.0/2.1/2.2 A and AA rule sets (so colour contrast and target size are included) on every P0 page, in the light and the dark theme, plus the task drawer open: 0 violations. New screens: add them to the page lists in that spec.
- The skip link is the first Tab stop on twelve pages and moves focus to `main-content`.
- Every Tab stop on the dashboard, customer list, board and task list has a visible focus indicator in both themes.
- Keyboard-only workflows: customer create (error announced, linked, focus on the invalid field), archive (dialog holds focus, Escape cancels and returns focus, Tab to the destructive button then Enter confirms) and restore; a stage move through the stage select and through the drag handle's keyboard sensor with its live-region announcements; the task drawer (focus held, Escape on unsaved work asks first, focus returns to its button) and completing a task; Reset Demo; the theme toggle; the phone navigation drawer.
- Not covered by automation, to repeat by hand when the UI changes a lot: a screen reader pass (VoiceOver) on the dashboard, a list, a form and the board.

## Shareable views, related-record links and what a URL may contain (SIT-270)

- **The URL is the list's state.** Search text, filters, sort, page and (reports) the date range live in the query string through `defineUrlState` / `useUrlState`; the same address in another session of the same workspace reproduces the view. Every list page (customers, opportunities, tasks, quotes, activity, reports) has a **Copy link** button that copies the address as it is.
- **What may be in a URL.** Only non-sensitive filter values: enum choices, ids of records in the active workspace, dates, sort keys, and the **search term the person typed**. `defineUrlState` refuses parameter names that look like secrets or contact data (email, phone, token, password, ...). Warning for contributors: a search box value is free text and ends up in the address bar, browser history, server logs and a copied link, so never put an email address, note text or other customer data in the URL on purpose, and never add a URL parameter that carries one. An id in a link only works for a member of that workspace; another workspace's id is a plain 404.
- **Related-record links** exist between every pair: customer to its opportunities, tasks and quotes (the tabs, each with an "open in the list" link); opportunity to its customer, tasks (`/app/tasks?opportunityId=`) and quotes (`/app/quotes?opportunityId=`); task to its customer and deal; quote to its customer and deal; activity event to its record; dashboard cards and every stage (chips, the visible table and the drawn bars) to the matching filtered list. A list opened from a record says so ("Showing only tasks linked to one deal.") with a **Show all** button. A hand-edited id that is not a UUID is ignored.
- **Archived targets** show an "Archived" badge (the DTOs carry `customerArchived`, `opportunityArchived`) and stay navigable.
- **Breadcrumbs and back links.** Detail pages have a breadcrumb trail. List pages remember their own URL for the browser tab (`list-memory.ts`, sessionStorage, validated to be a path of that list's route), and the breadcrumb and "Back to ..." links return to the list **with its filters**.

## Stale edits (409) in forms (SIT-271)

Every edit form answers a `STALE_EDIT` with the same pieces: `useConflict` (reads the latest record and works out which fields changed on each side from the form's baseline, the form now and the latest), `applyConflictToForm` (reload or "apply on top" into react-hook-form) and `<ConflictDialog>`. A form supplies the labels of its editable fields, a function that loads the latest values, and an `apply` callback that stores the new version for the next save. Nothing is saved without the person pressing Save, and a stale version is never silently replaced.
