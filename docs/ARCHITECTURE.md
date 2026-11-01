# Architecture

Sections are added as the system is built.

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
- **Holding pages:** routes whose feature ships later render `PlannedPage` (title, what it will do, milestone, a link back); no fake data. Each owning issue replaces its page.
- **Boundaries:** `not-found.tsx` and `error.tsx` exist at the root and inside `/app` (the latter keeps the shell), built on `StatePanel` / `ErrorPanel` in `src/components/shared`.
- **Auth guard:** `/app` layout carries a visible development notice and a TODO until SIT-180 adds the guard.

## Shared state components (SIT-163)

`src/components/shared` holds the reusable states: `TableSkeleton` / `CardSkeleton` / `ChartSkeleton`, `EmptyState`, `ErrorAlert` (shows the API error envelope's request ID), `ToastProvider` + `notify` (sonner), and `ConfirmDialog` (Radix alert dialog). Usage notes are in `src/components/shared/README.md`. `StatePanel`, `PlannedPage`, and `ErrorPanel` (SIT-176) share the same layout. `ConfirmDialog` restores focus itself because Radix only returns focus to its own `Trigger`, and dialogs here are opened from any control.

## Accessibility checklist

The baseline for every screen (PRD 3.2, WCAG 2.2 AA). Feature issues reference this list in their Definition of Done; the pull request template repeats it. Shared pieces already satisfy most items, so reuse them: `FormField`, `ErrorSummary`, `ErrorAlert`, `EmptyState`, the skeletons, `ConfirmDialog`, `notify` (all in `src/components/shared`), and the tokens in `src/app/globals.css`.

**Structure**

- One `h1` per page; headings in order; landmarks `header`, `nav` (labelled when there are several), `main`, `footer`; a page `title`.
- Skip link first in tab order, targeting `main#main-content`.

**Keyboard**

- Everything interactive is reachable and operable with the keyboard, in an order that matches the visual order. No keyboard traps.
- Focus is always visible. Never add `outline-none` without a `focus-visible` ring; ring colors are never translucent. A focused element must not hide under the sticky top bar (`scroll-padding-top` in `globals.css`).
- Dialogs trap focus, return it to the opener on close, and close on Esc unless an action is running (`ConfirmDialog` does this).
- Anything that needs dragging also has a non-drag control (the kanban board has a stage selector; WCAG 2.5.7).

**Names, labels, and forms**

- Every control has a visible label (`FormField`); helper text and errors are linked with `aria-describedby`; invalid controls set `aria-invalid`.
- A failed submit shows an `ErrorSummary` (announced, takes focus, links to each field). Errors say what is wrong and how to fix it, in words.
- Icon-only buttons have an `aria-label`; decorative icons and illustrations are `aria-hidden`; informative images have alt text.
- Identity fields set `autocomplete`; login and signup never require a cognitive test and allow pasting into password fields (WCAG 3.3.8).

**Color, contrast, and status**

- Use the tokens (contrast is tested in `contrast.test.ts`). Do not hard-code colors.
- Never color alone: pair status with an icon and text ("Overdue", not just red).

**Motion**

- Animate only to show what changed. All animation and transitions are removed under `prefers-reduced-motion` by the global rule. No auto-playing or looping motion.

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
