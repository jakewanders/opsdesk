import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanupExpiredDemos, type CleanupOptions, type CleanupResult } from "./cleanup";

/** Entry point for the scheduled function and the CLI: builds the admin client and runs one bounded cleanup. */
export function runDemoCleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
  return cleanupExpiredDemos(
    createAdminClient() as unknown as Parameters<typeof cleanupExpiredDemos>[0],
    options,
  );
}
