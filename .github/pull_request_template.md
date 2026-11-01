## What changed

<!-- One or two sentences. Link the Linear issue (SIT-nnn). -->

## Checks

- [ ] `npm run check` passes locally
- [ ] Tests cover the behavior, including a permissions or tenant-isolation case where data is involved

## UI changes only

- [ ] Meets the [accessibility checklist](../docs/ARCHITECTURE.md#accessibility-checklist): labels and errors via `FormField` / `ErrorSummary`, visible focus, keyboard path, no color-only status, works at 200% zoom
- [ ] Component test for the keyboard path and an `expectNoA11yViolations()` check
- [ ] Checked in light and dark themes
