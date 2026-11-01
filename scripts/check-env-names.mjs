#!/usr/bin/env node
import { checkEnvNames } from "./lib/env-names.mjs";

const roots = [".env.example", "src", "scripts", "netlify.toml", ".github", "next.config.ts"];
const problems = checkEnvNames(roots, process.env);
if (problems.length > 0) {
  console.error("Environment naming guard failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  "Environment naming guard passed: no NEXT_PUBLIC_* name contains SECRET, SERVICE or WEBHOOK.",
);
