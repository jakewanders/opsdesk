#!/usr/bin/env node
// Placeholder for npm scripts whose feature is built by a later issue.
// Usage: node scripts/not-implemented.mjs <script> <issue> "<what arrives>"
// Exits 0 on its own; `npm run check` / `npm test` only run these scripts once the feature
// exists (see scripts/lib/steps.mjs), where a failure is a real failure.
const [name = "this script", issue = "a later issue", what = ""] = process.argv.slice(2);
console.log(`${name}: not implemented yet. ${what ? what + " " : ""}Arrives with ${issue}.`);
