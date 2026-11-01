// Bundle grep: server-only variable names and values must not appear in client assets.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const SERVER_ONLY_NAMES = [
  "SUPABASE_SECRET_KEY",
  "TURNSTILE_SECRET_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "AI_API_KEY",
];

function* files(dir) {
  const stat = statSync(dir, { throwIfNoEntry: false });
  if (!stat) return;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/**
 * @param {string} dir client asset directory (.next/static)
 * @param {Record<string, string | undefined>} env
 * @returns {{ scanned: number, findings: string[] }}
 */
export function scanClientBundle(dir, env) {
  const needles = SERVER_ONLY_NAMES.map((name) => ({ label: `name ${name}`, text: name }));
  for (const name of SERVER_ONLY_NAMES) {
    const value = env[name];
    if (value && value.length >= 8) needles.push({ label: `value of ${name}`, text: value });
  }
  const findings = [];
  let scanned = 0;
  for (const file of files(dir)) {
    scanned += 1;
    const content = readFileSync(file, "utf8");
    for (const needle of needles) {
      if (content.includes(needle.text)) findings.push(`${file}: contains ${needle.label}`);
    }
  }
  return { scanned, findings };
}
