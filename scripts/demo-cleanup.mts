// `npm run demo:cleanup`: runs the same expired-demo cleanup core as the scheduled Netlify function (SIT-213, PRD 8.2).
//
//   npm run demo:cleanup                                  # local project (the URL and SUPABASE_SECRET_KEY come from the environment)
//   npm run demo:cleanup -- --confirm-remote <hostname>   # a non-local project: the hostname must be repeated exactly
//
// It needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY. Only counts and error codes are printed. Exit 0 when the run finished
// without errors (including "stopped at the time budget": run it again), 1 when any step failed, 2 when the guard refused to start.
import { createClient } from "@supabase/supabase-js";
import { cleanupExpiredDemos } from "../src/lib/cleanup/cleanup";
import { evaluateCleanupTarget, exitCodeFor } from "../src/lib/cleanup/guard";

const args = process.argv.slice(2);
const flag = args.indexOf("--confirm-remote");
const target = evaluateCleanupTarget({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  confirmRemote: flag >= 0 ? args[flag + 1] : undefined,
});
if (!target.ok) {
  console.error(`demo:cleanup refused (${target.code}): ${target.message}`);
  process.exit(2);
}

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  },
);
try {
  const result = await cleanupExpiredDemos(admin as never, {
    log: (event) =>
      console.log(JSON.stringify({ ...event, host: target.host, local: target.local })),
  });
  console.log(
    `demo:cleanup finished on ${target.host}: ${result.orgsDeleted} workspaces and ${result.usersDeleted} guests removed, ${result.errors} errors${result.truncated ? " (stopped early: run it again)" : ""}.`,
  );
  process.exit(exitCodeFor(result));
} catch (error) {
  // never print the error object: it can carry request details. A code and the class are enough.
  console.error(`demo:cleanup failed: ${error instanceof Error ? error.name : "unknown error"}`);
  process.exit(1);
}
