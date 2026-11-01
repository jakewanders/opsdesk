#!/usr/bin/env node
// Run after `npm run build`. Fails if a server-only variable name or value is in .next/static.
import { scanClientBundle } from "./lib/bundle-secrets.mjs";

const { scanned, findings } = scanClientBundle(".next/static", process.env);
if (scanned === 0) {
  console.error("No client assets found in .next/static. Run `npm run build` first.");
  process.exit(2);
}
if (findings.length > 0) {
  console.error("Server-only secrets found in the client bundle:");
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}
console.log(`Client bundle clean: ${scanned} files scanned, no server-only names or values.`);
