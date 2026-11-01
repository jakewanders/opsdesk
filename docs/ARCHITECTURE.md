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
