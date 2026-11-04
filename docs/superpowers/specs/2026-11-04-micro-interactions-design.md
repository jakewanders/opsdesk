# Micro-interactions and animations: design

Status: approved scope (tiers 1, 2 and 3), awaiting spec review. Date: 2026-11-04.

## Goal

Make OpsDesk feel responsive and polished with small, fast motion that confirms an action, shows where something went, or smooths a change of state.

## Constraints (decided)

- Stay inside the existing rule in `docs/ARCHITECTURE.md` (Motion): animate only to show what changed; nothing loops or auto-plays. **No decorative motion** (decided 2026-11-04).
- **No new animation dependency.** Use CSS, `tw-animate-css`, `@dnd-kit` (already present) and React 19.3 `<ViewTransition>`.
- Nothing longer than 280ms except a one-time count-up (up to 600ms).
- Animate `transform` and `opacity` only. One exception: the task-row collapse uses `grid-template-rows`.
- No layout shift. Pending buttons and swapped icons keep their size (Lighthouse and performance e2e specs exist).
- `prefers-reduced-motion` is honored by every piece: CSS through the global rule in `src/app/globals.css`, JS-driven motion through a shared `usePrefersReducedMotion`.

## Tier 1: Foundation

1. **Motion tokens** in `src/app/globals.css`: `--motion-fast` 120ms, `--motion-base` 180ms, `--motion-slow` 280ms; `--ease-out`, `--ease-in-out`, `--ease-settle` (slight overshoot, used only for board drops). Exposed to Tailwind through `@theme inline`.
2. **Shared hook**: move `usePrefersReducedMotion` from `src/features/reports/use-reduced-motion.ts` to `src/lib/motion/` and update importers (`stage-chart.tsx` and `board-dnd.tsx` currently duplicate the media query inline).
3. **Button** (`src/components/ui/button.tsx`): use tokens for transitions; add a `pending` state where the label crossfades to a spinner with the button width held. Adopt in forms and `demo-entry.tsx`.
4. **Inputs**: focus ring and error state transition with tokens; error text fades in (no shake).
5. **Overlays** (dialog, sheet, drawer, dropdown, select, alert-dialog): one shared enter/exit curve and duration.
6. **Skeleton** (`src/components/ui/skeleton.tsx`): replace `animate-pulse` with a calm shimmer; add a short fade when real content replaces it. The existing inline `animate-pulse` placeholders in the dashboard, activity and stage chart move to `Skeleton`.

## Tier 2: Feedback moments

| Surface               | Interaction                                                                                                    | Files                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Pipeline board        | Card settles into its column after a drop (`--ease-settle`); a failed move eases back; drop-target column tint | `features/opportunities/components/pipeline-board.tsx`, `board-dnd.tsx`, `use-move-stage.ts` |
| Task completion       | Check draws, row dims, row collapses out; undo restores in place                                               | `features/dashboard/components/dashboard-tasks.tsx`, tasks page                              |
| Dashboard KPIs        | Count up once on first load; tween on value change                                                             | `features/dashboard/components/kpi-card.tsx`                                                 |
| Charts                | Keep existing animation; hovering a table row highlights its chart segment                                     | `stage-chart.tsx`, `report-chart.tsx`                                                        |
| Tables and lists      | New or edited row gets a one-time highlight fade                                                               | `components/ui/table.tsx`, list views                                                        |
| Toasts                | Tune slide and fade; action buttons confirm visibly                                                            | `components/ui/sonner.tsx`, `components/shared/toast.tsx`                                    |
| Quote status          | Badge crossfade between states; one-time check flourish on Accepted                                            | `features/quotes/components/quote-actions.tsx`                                               |
| Copy and save buttons | Icon swaps to a checkmark for 1.5s, then back                                                                  | shared button usage                                                                          |

## Tier 3: Navigation with `<ViewTransition>`

Follows `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md`.

- Route crossfade between `/app` pages; directional slide when entering a detail page and when going back.
- Shared-element morph from a list row or card to the detail header (customers, opportunities).
- Suspense reveal: dashboard skeletons fade into content.
- All wrapped in one component under `src/components/layout/` so the feature can be disabled in one place. Unsupported browsers (older than Chromium 125) simply don't animate.
- Built last. Read the installed Next.js docs again before writing it (see `AGENTS.md`).

## Delivery

1. Tier 1: one PR.
2. Tier 2: one PR per surface, in the order board, tasks, KPIs, toasts, tables, quote status.
3. Tier 3: one PR.

## Testing and verification

- Unit: motion tokens exist in both themes; `usePrefersReducedMotion` returns the media-query value; count-up renders the final value immediately under reduced motion.
- Component: pending button keeps its width; task row is removed from the DOM after collapse (and restored on undo).
- E2E: run the accessibility and key flow specs under `reducedMotion: "reduce"` as well as the default (only `e2e/dashboard.spec.ts` does this today). E2E waits on state, never on animation timers, to avoid the slow-runner flakes fixed in commit 150b703.
- Manual: before each PR is called done, check in a real browser, light and dark, desktop and mobile; run `npm run check`.

## Out of scope

Decorative or ambient motion, landing-page effects, sound, haptics, and any new animation library.
