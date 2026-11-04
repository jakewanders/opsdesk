# Micro-interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add small, fast, reduced-motion-safe interactions to OpsDesk: shared motion tokens, pending buttons, calmer skeletons, board/task/KPI/toast/table/quote feedback, and view transitions between pages.

**Architecture:** CSS custom properties (`--motion-*`, `--ease-*`) in `globals.css` are the single vocabulary. A small `src/lib/motion/` module holds the shared reduced-motion hook and a "fresh id" store that lets any mutation say "this row just changed" so lists can highlight it. Navigation motion uses React 19.3 `<ViewTransition>` behind one wrapper. No new dependencies.

**Tech Stack:** Next.js 16.4.3 (`cacheComponents: true`), React 19.3, Tailwind 4, `tw-animate-css`, Radix, `sonner`, `@dnd-kit/core`, Recharts, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-micro-interactions-design.md`

## Global Constraints

- No new animation dependency (CSS, `tw-animate-css`, `@dnd-kit`, React `ViewTransition` only).
- Durations: `--motion-fast` 120ms, `--motion-base` 180ms, `--motion-slow` 280ms. Nothing longer, except the one-time KPI count-up (max 600ms).
- Animate `transform` and `opacity` only. Sole exception: task-row collapse uses `grid-template-rows`.
- No layout shift: pending buttons and swapped icons keep their size.
- Nothing loops or auto-plays. The skeleton shimmer replaces the existing `animate-pulse` loop and is the only repeating animation; the global reduced-motion rule in `globals.css` already freezes it.
- Every JS-driven animation checks `usePrefersReducedMotion()`; every CSS animation is covered by the existing global `prefers-reduced-motion` rule.
- No decorative motion (landing page untouched).
- Before touching `<ViewTransition>` code (Tasks 11-12), re-read `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md` (AGENTS.md: this Next.js has breaking changes).
- Work on branch `feat/micro-interactions`. Run `npm run check` before each task's commit if it touches more than one directory; otherwise the task's own test command.

## Review Focus

- Reduced motion on: count-up shows the final number at once; task row leaves with no delay; nothing waits on a timer.
- Rapid repeat: double-clicking a pending button, or completing two tasks quickly, must not fire the action twice or leave a row stuck half-collapsed.
- Failed mutation: a board move or task completion that errors must restore the card/row (existing rollback) and not leave a "fresh" highlight or collapsed row behind.
- Server render / hydration: components using the reduced-motion hook must render the same markup on server and first client paint (no hydration warning).
- KPI value changing from a number to `-` or to a rounded string (`$1.2M`): count-up must not produce `NaN` or flicker.

## File Structure

| File | Responsibility |
|---|---|
| `src/app/globals.css` | Motion tokens, `shimmer` / `settle` / `flash` keyframes |
| `src/lib/motion/use-prefers-reduced-motion.ts` | Shared hook (moved from reports) |
| `src/lib/motion/fresh.ts` | `markFresh(id)`, `useIsFresh(id)` store |
| `src/lib/motion/use-count-up.ts` | Count-up hook for KPIs |
| `src/components/ui/button.tsx` | Tokens + `pending` prop |
| `src/components/ui/skeleton.tsx` | Shimmer skeleton |
| `src/components/layout/page-transition.tsx` | Single `<ViewTransition>` wrapper |

---

### Task 1: Motion tokens and shared reduced-motion hook

**Files:**
- Modify: `src/app/globals.css` (add tokens to `:root`, expose in `@theme inline`)
- Create: `src/lib/motion/use-prefers-reduced-motion.ts`, `src/lib/motion/use-prefers-reduced-motion.test.ts`
- Modify: `src/features/dashboard/components/stage-chart.tsx:24-33` (delete inline copy, import shared), `src/features/reports/components/report-chart.tsx:8` (import path), `src/features/opportunities/components/board-dnd.tsx:89-100` (delete `useReducedMotion`, import shared)
- Delete: `src/features/reports/use-reduced-motion.ts`
- Test: `src/lib/design/motion-tokens.test.ts`

**Interfaces:**
- Produces: `usePrefersReducedMotion(): boolean` exported from `@/lib/motion/use-prefers-reduced-motion`. Server snapshot returns `true`. CSS vars `--motion-fast: 120ms`, `--motion-base: 180ms`, `--motion-slow: 280ms`, `--ease-out: cubic-bezier(0.22, 1, 0.36, 1)`, `--ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)`, `--ease-settle: cubic-bezier(0.34, 1.4, 0.64, 1)`. Tailwind usage: `duration-(--motion-base)`, `ease-(--ease-out)`.

- [ ] **Step 1: Write failing tests.** `motion-tokens.test.ts` reads `src/app/globals.css` with `fs` and asserts each of the six variables above is declared with exactly the values listed. `use-prefers-reduced-motion.test.ts` stubs `window.matchMedia` to `matches: true`, renders a probe with `renderHook`, expects `true`; then `matches: false`, expects `false`.
- [ ] **Step 2:** Run `npx vitest run src/lib/design/motion-tokens.test.ts src/lib/motion` — expect FAIL.
- [ ] **Step 3:** Declare the tokens in `:root` of `globals.css`; implement the hook by moving the `useSyncExternalStore` body from `src/features/reports/use-reduced-motion.ts` unchanged.
- [ ] **Step 4:** Replace the three duplicate hooks with the shared import; delete the old file.
- [ ] **Step 5:** Run `npx vitest run src/lib src/features/reports src/features/dashboard src/features/opportunities` — expect PASS.
- [ ] **Step 6:** Commit `feat(motion): motion tokens and shared reduced-motion hook`.

---

### Task 2: Fresh-id store

**Files:**
- Create: `src/lib/motion/fresh.ts`, `src/lib/motion/fresh.test.ts`

**Interfaces:**
- Produces: `markFresh(id: string): void` (id stays fresh for 1600ms, calling again restarts the timer); `useIsFresh(id: string): boolean` (via `useSyncExternalStore`, server snapshot `false`); `clearFreshForTests(): void`.

- [ ] **Step 1: Write failing tests** with fake timers: after `markFresh("a")`, `useIsFresh("a")` is `true` and `useIsFresh("b")` is `false`; after `vi.advanceTimersByTime(1600)` it is `false`; a second `markFresh("a")` at 1000ms keeps it `true` until 2600ms.
- [ ] **Step 2:** Run `npx vitest run src/lib/motion/fresh.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement with a module-level `Map<string, ReturnType<typeof setTimeout>>` and a listener set.
- [ ] **Step 4:** Run the test — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): fresh-id store`.

---

### Task 3: Button tokens and pending state

**Files:**
- Modify: `src/components/ui/button.tsx` (base class `transition-all` → `transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--motion-fast) ease-(--ease-out)`; add `pending` prop)
- Modify: `src/components/demo/demo-entry.tsx:117,123` (use `pending`), and the primary submit buttons of `src/app/(auth)/login/page.tsx` forms if they use a local pending flag (search `isPending`/`pending` in `src/app/(auth)` and `src/components/auth`)
- Test: `src/components/ui/button.test.tsx` (create)

**Interfaces:**
- Produces: `Button` accepts `pending?: boolean`. When true: sets `aria-busy="true"` and `disabled`, ignores clicks, keeps the children rendered but `invisible`, and shows a `Loader2` (`aria-hidden`, `motion-reduce:animate-none`) absolutely centered, so width is unchanged. The `Button` root gets `relative`.

- [ ] **Step 1: Write failing tests:** (a) `pending` button is `disabled`, has `aria-busy="true"`, onClick not called when clicked via `userEvent`; (b) its text content is still present (`getByText("Save changes")` exists) so accessible name is unchanged; (c) non-pending button has no `aria-busy`.
- [ ] **Step 2:** Run `npx vitest run src/components/ui/button.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement `pending` in `Button`. With `asChild`, `pending` is ignored (Slot cannot take an overlay child).
- [ ] **Step 4:** Adopt `pending` in `demo-entry.tsx` and in each auth/form submit button found by the search, replacing hand-rolled spinner markup. Keep existing visible labels.
- [ ] **Step 5:** Run `npx vitest run src/components src/app` — expect PASS (fix any test that asserted the old spinner markup).
- [ ] **Step 6:** Commit `feat(motion): button tokens and pending state`.

---

### Task 4: Inputs and overlays

**Files:**
- Modify: `src/components/ui/input.tsx` (transition list uses `duration-(--motion-fast)`), `dialog.tsx`, `sheet.tsx`, `drawer.tsx`, `dropdown-menu.tsx`, `select.tsx`, `alert-dialog.tsx` (every `duration-*` / `animate-in` / `animate-out` class set to `duration-(--motion-base) ease-(--ease-out)`; exit uses `duration-(--motion-fast)`)
- Test: `src/lib/design/motion-tokens.test.ts` (extend)

**Interfaces:**
- Consumes: tokens from Task 1.

- [ ] **Step 1: Extend the token test:** for each of the seven `ui/*.tsx` files above, assert the source contains `--motion-` and contains no literal `duration-100`, `duration-150`, `duration-200`, `duration-300` classes.
- [ ] **Step 2:** Run it — expect FAIL.
- [ ] **Step 3:** Replace the literal durations with the tokens in each file. Dialog/alert-dialog/sheet overlay: fade only. Dialog/popover content: fade plus `zoom-in-95`. Sheet/drawer: existing slide, token duration. Form error text in `src/components/ui/input.tsx` neighbors (`aria-invalid` styles) transitions in with the same tokens; no keyframe shake.
- [ ] **Step 4:** Run `npx vitest run src/components/ui src/lib/design` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): consistent overlay and input timing`.

---

### Task 5: Shimmer skeleton and reveal

**Files:**
- Modify: `src/app/globals.css` (`@keyframes shimmer`, `.skeleton-shimmer` class), `src/components/ui/skeleton.tsx`
- Modify: `src/features/dashboard/components/dashboard-tasks.tsx:138`, `dashboard-view.tsx:44,47`, `stage-chart.tsx:19`, `src/features/activity/components/activity-view.tsx:188` (replace inline `animate-pulse` divs with `<Skeleton className="...same sizes..." />`)
- Test: `src/components/ui/skeleton.test.tsx` (create)

**Interfaces:**
- Produces: `Skeleton` (same props) renders `data-slot="skeleton"` with class `skeleton-shimmer` and no `animate-pulse`. Shimmer is a `transform: translateX` sweep on a `::after`, 1.4s, ease-in-out. Content that replaces a skeleton gets class `animate-in fade-in duration-(--motion-base)` on its wrapper in the same four files.

- [ ] **Step 1: Write failing tests:** `Skeleton` has class `skeleton-shimmer` and not `animate-pulse`; `grep`-style test in `skeleton.test.tsx` that no file under `src/features` or `src/components` (excluding tests) contains `animate-pulse`.
- [ ] **Step 2:** Run `npx vitest run src/components/ui/skeleton.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement CSS and component; migrate the five inline placeholders; add the fade-in wrapper to the replacing content.
- [ ] **Step 4:** Run `npx vitest run src/features/dashboard src/features/activity src/components` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): shimmer skeleton and content reveal`.

---

### Task 6: Pipeline board feedback

**Files:**
- Modify: `src/app/globals.css` (`@keyframes settle`: from `translateY(-6px) scale(1.02)` to identity, `--motion-slow`, `--ease-settle`; `.animate-settle`), `src/features/opportunities/use-move-stage.ts` (call `markFresh(deal.id)` in `onMutate`; on `onError` call nothing extra — rollback already restores), `src/features/opportunities/components/pipeline-board.tsx` (card gets `animate-settle` when `useIsFresh(deal.id)`; column tint uses `duration-(--motion-fast)`)
- Test: `src/features/opportunities/components/pipeline-board.test.tsx` (extend)

**Interfaces:**
- Consumes: `markFresh`, `useIsFresh` (Task 2). `usePrefersReducedMotion` not needed (CSS-only; global rule covers it).

- [ ] **Step 1: Write failing tests:** after a successful `useMoveStage` mutation, the moved card in the destination column has class `animate-settle`; after the mutation fails (mock 409), the card is back in its original column and has no `animate-settle` (call `clearFreshForTests`-aware: `markFresh` is only called after `onSuccess`, so move the `markFresh` call to `onSuccess`, not `onMutate`).
- [ ] **Step 2:** Run `npx vitest run src/features/opportunities/components/pipeline-board.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement as described, with `markFresh` in `onSuccess`. Drop-target column keeps its ring; add `transition-[background-color,box-shadow] duration-(--motion-fast)`.
- [ ] **Step 4:** Run `npx vitest run src/features/opportunities` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): board drop settle`.

---

### Task 7: Task completion

**Files:**
- Modify: `src/features/dashboard/components/dashboard-tasks.tsx` (`Section`), `src/app/app/tasks/page.tsx` list component if it renders the same row (search `useCompleteTask`), `src/app/globals.css` (`.row-collapse` using `grid-template-rows: 1fr → 0fr` and `opacity`)
- Test: `src/features/dashboard/components/dashboard-view.test.tsx` (extend)

**Interfaces:**
- Produces: in `Section`, local state `leavingId: string | null`. Clicking complete sets `leavingId`, then calls `onComplete(task)` after `--motion-base` (180ms) via `setTimeout`, or immediately when `usePrefersReducedMotion()` is true. The check icon in the button uses a `stroke-dashoffset` draw (`.check-draw`) only while leaving. A success toast gets an "Undo" action calling `complete.mutate({ task, completed: false })`; the reopened row mounts with `animate-in fade-in duration-(--motion-base)`.

- [ ] **Step 1: Write failing tests:** with reduced motion stubbed `true`, clicking "Mark X complete" calls the mutation synchronously; with reduced motion `false` and fake timers, the mutation is not called until 180ms pass and the `li` has the `row-collapse` class meanwhile; a second click on another task during the collapse does not call the mutation twice for the first; if the mutation rejects, the row is present again with no `row-collapse` class.
- [ ] **Step 2:** Run `npx vitest run src/features/dashboard/components/dashboard-view.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement. Clear `leavingId` in `onSettled`/after the delayed call so a rolled-back row is not stuck collapsed.
- [ ] **Step 4:** Run `npx vitest run src/features/dashboard src/features/tasks` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): task completion animation with undo`.

---

### Task 8: KPI count-up

**Files:**
- Create: `src/lib/motion/use-count-up.ts`, `src/lib/motion/use-count-up.test.ts`
- Modify: `src/features/dashboard/components/kpi-card.tsx`, and its caller in `dashboard-view.tsx` to pass `numeric?: { value: number; format: (n: number) => string }`

**Interfaces:**
- Produces: `useCountUp(target: number, opts?: { duration?: number }): number` — returns the displayed value. First mount animates from 0 to `target` over `duration` (default 600ms, `requestAnimationFrame`, ease-out); later target changes tween from the current value over 280ms. Returns `target` immediately when `usePrefersReducedMotion()` is true or when `target` is not finite. `KpiCard` gains optional `numeric`; when absent it renders `value` as today. The `title` / sr-only text always carries the final formatted value, never the in-between one.

- [ ] **Step 1: Write failing tests** (fake `requestAnimationFrame`): reduced motion → returns target on first render; normal → first render returns `0`, after full duration returns target; target change `10 → 20` mid-animation never returns `NaN` and ends at `20`; `NaN` target returns `NaN`-free `0`... specifically `useCountUp(Number.NaN)` returns `0` and starts no animation.
- [ ] **Step 2:** Run `npx vitest run src/lib/motion/use-count-up.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement the hook and wire `KpiCard`; in `dashboard-view.tsx` pass `numeric` only for count and currency KPIs, leaving string-only KPIs unchanged.
- [ ] **Step 4:** Run `npx vitest run src/lib/motion src/features/dashboard` — expect PASS (existing dashboard tests must still see final values; stub reduced motion in `vitest.setup.ts` if needed so tests are not time-dependent).
- [ ] **Step 5:** Commit `feat(motion): KPI count-up`.

---

### Task 9: Chart hover emphasis

**Files:**
- Modify: `src/features/dashboard/components/stage-chart-impl.tsx` (Recharts `Bar` `onMouseEnter` / `onMouseLeave` set `activeStage`; each `Cell` gets `fillOpacity` 1 for active or none active, `0.45` otherwise, with `style={{ transition: "fill-opacity var(--motion-fast)" }}`), `src/features/reports/components/report-chart.tsx` (same for its bars)
- Test: `src/features/dashboard/components/stage-chart.test.tsx` (extend)

**Interfaces:**
- Note: the spec said "hovering a table row highlights its chart segment", but the table is only an alternative view of the chart and never shown beside it, so emphasis happens on the chart itself.

- [ ] **Step 1: Write failing test:** mouse-entering a bar's cell dims the other cells (`fill-opacity` 0.45) and leaving restores all to 1.
- [ ] **Step 2:** Run `npx vitest run src/features/dashboard/components/stage-chart.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement in both chart files.
- [ ] **Step 4:** Run `npx vitest run src/features/dashboard src/features/reports` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): chart hover emphasis`.

---

### Task 10: Fresh-row highlight, toasts, quote status, copy feedback

**Files:**
- Modify: `src/app/globals.css` (`@keyframes flash`: background from `var(--accent)` to transparent, `--motion-slow`; `.animate-flash`), `src/components/ui/table.tsx` (`TableRow` accepts `data-fresh` styling: `data-[fresh=true]:animate-flash`), customer and quote list/table views (search `useApiMutation` `onSuccess` in `src/features/customers` and `src/features/quotes` and call `markFresh(result.id)`; rows pass `data-fresh={useIsFresh(id)}` through a small `FreshRow` wrapper in `src/components/ui/table.tsx`)
- Modify: `src/components/ui/sonner.tsx` and `src/components/shared/toast.tsx` (`toastOptions.classNames.actionButton` gets token transitions; remove the now-wrong comment claim that motion is only removed globally, keep accurate wording)
- Modify: `src/features/quotes/components/quote-status.tsx` (wrap in `key={status}` span with `animate-in fade-in duration-(--motion-base)`), `quote-actions.tsx` (after a transition to `approved` call `markFresh(quote.id)`; `QuoteStatus` shows a one-time `animate-settle` check when fresh and `status === "approved"`)
- Modify: `src/components/shared/copy-link-button.tsx`, `copy-request-id.tsx` (icon swaps `Copy` → `Check` for 1500ms; label for assistive tech via existing live region/toast, unchanged)
- Test: `src/components/shared/link-parts.test.tsx`, `src/features/quotes/components/quote-detail-parts.test.tsx` (extend)

**Interfaces:**
- Consumes: `markFresh`, `useIsFresh` (Task 2); `animate-settle` (Task 6).
- Produces: `FreshRow({ id, ...TableRowProps })` exported from `@/components/ui/table`.

- [ ] **Step 1: Write failing tests:** (a) copy button shows the check icon (`data-testid="copied-icon"`) after click and the copy icon after 1500ms with fake timers; (b) `QuoteStatus status="approved"` renders with `animate-settle` check only when `markFresh(id)` was called, otherwise not; (c) `FreshRow` has `data-fresh="true"` right after `markFresh(id)` and `"false"` after 1600ms.
- [ ] **Step 2:** Run the three test files — expect FAIL.
- [ ] **Step 3:** Implement the five edits above. `QuoteStatus` takes an optional `id?: string` prop (callers in `quote-header.tsx` and `customer-quotes.tsx` pass the quote id).
- [ ] **Step 4:** Run `npx vitest run src/components src/features/quotes src/features/customers` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): fresh-row highlight, toast and status feedback, copy confirmation`.

---

### Task 11: Page transition wrapper and route crossfade

**Files:**
- Create: `src/components/layout/page-transition.tsx`, `src/components/layout/page-transition.test.tsx`
- Modify: `src/app/app/layout.tsx` (wrap `children` inside `DynamicShell` content area), `src/app/globals.css` (`::view-transition-old(root)` / `::view-transition-new(root)` fade rules and the `nav-forward` / `nav-back` slide classes, all duration `--motion-base`; wrapped in `@media (prefers-reduced-motion: no-preference)`)
- Modify: `next.config.ts` only if the installed docs say a flag is required (they state none; verify first)

**Interfaces:**
- Produces: `PageTransition({ children }: { children: ReactNode })` — renders `<ViewTransition default="none" enter={{ "nav-forward": "nav-forward", "nav-back": "nav-back", default: "none" }} exit={...} >`. Forward vs back is set by `addTransitionType("nav-forward" | "nav-back")` in `nav-list.tsx` link `onClick` (forward) and detail pages' back links (back). Keep the mapping in this one file; if `ViewTransition` or the API names differ from the installed docs, follow the docs and keep the same wrapper signature.

- [ ] **Step 1:** Re-read `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md` (route transitions and same-route sections).
- [ ] **Step 2: Write failing test:** `PageTransition` renders its children and does not throw when `ViewTransition` is unsupported (stub `document.startViewTransition` as undefined); children appear exactly once.
- [ ] **Step 3:** Run `npx vitest run src/components/layout/page-transition.test.tsx` — expect FAIL.
- [ ] **Step 4:** Implement wrapper, CSS and `app/layout.tsx` wiring; mark forward navigation from `nav-list.tsx` and list-row links.
- [ ] **Step 5:** Run `npx vitest run src/components/layout src/app` and `npm run typecheck` — expect PASS.
- [ ] **Step 6:** Commit `feat(motion): page crossfade with view transitions`.

---

### Task 12: Shared-element morph and Suspense reveal

**Files:**
- Modify: `src/features/customers/components/*` list row name and `src/app/app/customers/[id]/page.tsx` header name; `src/features/opportunities/components/pipeline-board.tsx` card title and `src/app/app/opportunities/[id]/page.tsx` header title; dashboard Suspense boundaries in `src/features/dashboard/components/dashboard-view.tsx`
- Test: `src/features/customers/components/*.test.tsx`, `src/features/opportunities/components/pipeline-board.test.tsx` (extend)

**Interfaces:**
- Produces: `<ViewTransition name={`customer-${id}`}>` around the name element in list row and detail header; same for `opportunity-${id}`; `<ViewTransition>` around Suspense fallback/content pairs so skeleton → content cross-fades (`default="none"`, `update="auto"` per docs). Names are unique per entity id so list pages with many rows never share a name.

- [ ] **Step 1: Write failing tests:** rendering a list of two customers yields no duplicate `view-transition-name` values; the detail header has the name matching the row for the same id. (jsdom does not run transitions; assert via the `name` prop captured from a mocked `ViewTransition`.)
- [ ] **Step 2:** Run the extended tests — expect FAIL.
- [ ] **Step 3:** Implement. Only wrap the name text, never the whole row, to avoid snapshotting interactive content.
- [ ] **Step 4:** Run `npx vitest run src/features` — expect PASS.
- [ ] **Step 5:** Commit `feat(motion): shared-element morph and Suspense reveal`.

---

### Task 13: End-to-end, reduced motion and docs

**Files:**
- Modify: `playwright.config.ts` (add projects `desktop-reduced` and `mobile-reduced` with `use: { contextOptions: { reducedMotion: "reduce" } }`, or an equivalent supported option for the installed Playwright), `e2e/accessibility.spec.ts`, `e2e/mobile.spec.ts` (run in the reduced projects too), `e2e/dashboard.spec.ts` (assert KPI shows final value under reduced motion)
- Modify: `docs/ARCHITECTURE.md` Motion section (name the tokens, the fresh-id store, `PageTransition`, and that the skeleton shimmer is the single repeating animation)
- Modify: `docs/DECISIONS.md` (one row: no animation dependency; chart emphasis on-chart not table; "Approved" not "Accepted")

- [ ] **Step 1:** Add the Playwright projects and extend the three specs. No spec may use `waitForTimeout`; wait on visible state.
- [ ] **Step 2:** Run `npm run test:e2e:scenarios-7-10` and `npm run test:e2e:scenarios` — expect PASS in both normal and reduced projects.
- [ ] **Step 3:** Run `npm run check` — expect PASS (lint, typecheck, unit, bundle-secret checks).
- [ ] **Step 4:** Manual pass in a real browser (`npm run dev`), light and dark, desktop and 390px mobile: board drop, task complete and undo, KPI load, toast, quote approve, copy buttons, page navigation back and forth, with OS reduced motion on and off. Record anything off as a follow-up, not a silent fix.
- [ ] **Step 5:** Update the docs and commit `docs(motion): record motion system and decisions`.

## Self-review notes

- **Spec coverage:** Tier 1 → Tasks 1, 3, 4, 5 (hook move in 1). Tier 2 → Tasks 6, 7, 8, 9, 10. Tier 3 → Tasks 11, 12. Testing/verification section → Task 13 plus per-task tests.
- **Two deliberate deviations from the spec,** both recorded in `docs/DECISIONS.md` by Task 13: chart emphasis happens on the chart (the table view is never beside it), and the quote flourish is on "Approved" (the app's actual status name).
- **Proportion:** each task carries signatures, test assertions and spec values; bodies are left to the implementer.
