#!/usr/bin/env node
// `npm run check` and `npm test`: run each planned step, stop at the first failure.
import { spawnSync } from "node:child_process";
import { planSteps } from "./lib/steps.mjs";

const mode = process.argv[2] === "test" ? "test" : "check";
const steps = planSteps(mode);
console.log(`npm run ${mode}: ${steps.join(" > ")}\n`);

for (const step of steps) {
  console.log(`\n=== npm run ${step} ===`);
  const result = spawnSync("npm", ["run", step], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n${mode} failed at "${step}" (exit ${result.status ?? "signal"}).`);
    process.exit(result.status ?? 1);
  }
}
console.log(`\nnpm run ${mode}: all ${steps.length} steps passed.`);
