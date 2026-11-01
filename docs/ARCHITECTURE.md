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
