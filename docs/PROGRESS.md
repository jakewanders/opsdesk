# Progress log

Real command results only. Updated after every issue and milestone.

## Waiting on Jake

_(none yet)_

## M0 — Foundation & Application Architecture

### SIT-150 — Bootstrap Next.js (done)

- `rm -rf node_modules .next && npm ci && npm run build`: succeeded (Next 16.4.3, routes `/` and `/_not-found` static).
- `npm run typecheck` (`tsc --noEmit`, `strict: true`): no errors. `grep` for `any` in `src/`: none.
- `npm run lint`: clean.
- `npm run dev`: `curl http://localhost:3000` returned the placeholder `<h1>OpsDesk</h1>`.
- `npm audit`: 16 moderate advisories in the default scaffold's dependency tree, not addressed here (no `--force` upgrades).
- No `.env*` or secret files in the tree.

### SIT-156 — ESLint, Prettier, Vitest (done)

- `rm -rf node_modules && npm ci` then `npm run lint`, `format:check`, `typecheck`, `test:unit`: all pass (2 files, 4 tests).
- Negative check: `export const bad = (x: any) => x;` made `npm run lint` fail with `@typescript-eslint/no-explicit-any` (1 error); file removed.
- Negative check: a deliberately failing test made `npm run test:unit` exit 1 (1 failed, 4 passed); file removed.
- `npm run test:coverage` runs (v8 reporter): All files 50% stmts on the sample code.

### SIT-159 — shadcn/ui, design tokens, persisted theme (done)

- `npm run test:unit`: 4 files, 57 tests pass (light and dark token contrast: all text pairs >= 4.5:1, control borders and rings >= 3:1; ThemeToggle: default light, cycle and persist, restore stored dark).
- Mutation check: changing `--muted-foreground` to `#b0aca5` made 2 contrast tests fail; reverted.
- `npm run lint`, `format:check`, `typecheck`, `build`: pass.
- Browser check on `npm run dev` (Playwright): clicking the toggle set `html.dark` and `localStorage opsdesk-theme=dark`; after reload the page was still dark (body background `rgb(20, 20, 19)`), and the inline theme script precedes `<main>` in the HTML. Computed focus ring on the toggle: solid `rgb(76, 195, 180)` 3px. IBM Plex Sans applied.
- Not done here: Lighthouse/axe scores (later accessibility issues, SIT-175 and P-09).
