#!/usr/bin/env node
// `node scripts/scan-logs.mjs <file>...`: scan server log output (for example an end-to-end run's output) for secrets, personal
// data, record contents, stack traces and database internals. Exit 1 when anything is found. Prints rule names and places, never values.
import { readFileSync } from "node:fs";
import { scanLogLines } from "./lib/log-scan.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/scan-logs.mjs <file>...");
  process.exit(2);
}
let bad = 0;
for (const file of files) {
  const { jsonLines, findings } = scanLogLines(readFileSync(file, "utf8").split("\n"));
  console.log(`${file}: ${jsonLines} server log lines scanned, ${findings.length} findings`);
  for (const f of findings.slice(0, 50)) console.log(`  line ${f.line}: ${f.rule} (${f.where})`);
  if (jsonLines === 0) {
    console.error(`  no server log lines found in ${file}: the scan would pass on nothing`);
    bad += 1;
  }
  bad += findings.length;
}
process.exit(bad === 0 ? 0 : 1);
