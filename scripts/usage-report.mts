// `npm run usage:report`: prints the first-party daily demo usage counts (P-03, SIT-146). Counts and rates only; no ids, no emails.
//
//   npm run usage:report                                      # the last 30 days on the local project
//   npm run usage:report -- --days 7                          # another window (1 to 400)
//   npm run usage:report -- --confirm-remote <hostname>       # a non-local project: the hostname must be repeated exactly
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY, the same two variables and the same guard as `npm run demo:cleanup`.
// Exit 0 on success, 1 when the report could not be read, 2 when the guard refused to start.
import { createClient } from "@supabase/supabase-js";
import { evaluateCleanupTarget } from "../src/lib/cleanup/guard";
import {
  REPORT_NOTES,
  buildUsageReport,
  formatUsageReport,
  type UsageRow,
} from "../src/lib/usage/report";

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const target = evaluateCleanupTarget({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  confirmRemote: value("--confirm-remote"),
});
if (!target.ok) {
  console.error(
    `usage:report refused (${target.code}): ${target.message.replace("run the cleanup against it", "read the usage report from it")}`,
  );
  process.exit(2);
}
const rawDays = value("--days");
const days = rawDays === undefined ? 30 : Number(rawDays);
if (!Number.isInteger(days) || days < 1 || days > 400) {
  console.error("usage:report refused (BAD_DAYS): --days must be a whole number from 1 to 400.");
  process.exit(2);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
);
try {
  const { data, error } = await admin.rpc("usage_report", { days });
  if (error) {
    console.error(`usage:report failed (${error.code ?? "unknown"}).`);
    process.exit(1);
  }
  const report = buildUsageReport((data ?? []) as UsageRow[], days, new Date());
  console.log(`Demo usage on ${target.host}, last ${days} days (counts only)\n`);
  console.log(formatUsageReport(report));
  console.log("\n" + REPORT_NOTES.map((n) => `  ${n}`).join("\n"));
  process.exit(0);
} catch (error) {
  // never print the error object: it can carry request details. The class is enough.
  console.error(`usage:report failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exit(1);
}
