import { logger } from "@/lib/logger/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Two-phase cleanup of expired demo workspaces (PRD 8.2, SIT-207).
 *
 * Phase 1 (database): delete expired DEMO organizations in bounded batches (`cleanup_purge_expired_demos`), which runs
 * each organization's registered clear functions first and queues its anonymous owner. Phase 2 (Auth Admin API):
 * delete each queued user, but only after the database safety predicate says it is an anonymous user with no
 * membership and no real organization (fail closed). A failure leaves the user queued for the next run and never
 * blocks phase 1. A time budget bounds the whole invocation. Only counts and error codes are returned or logged.
 *
 * The client must be the ADMIN (secret-key) client: the functions it calls are executable by `service_role` only.
 */
type AdminClient = Pick<SupabaseClient, "rpc"> & {
  auth: {
    admin: {
      deleteUser: (id: string) => Promise<{ error: { code?: string; status?: number } | null }>;
    };
  };
};

export type CleanupOptions = {
  /** Organizations per phase-1 call and users per phase-2 fetch. Default 50. */
  batchSize?: number;
  /** Stop starting new work after this many milliseconds. Default 20 000, under typical serverless limits. */
  timeBudgetMs?: number;
  /** An anonymous user with no organization must be at least this old to be queued as an orphan. Default 48. */
  orphanMinAgeHours?: number;
  /** Monotonic millisecond clock (injectable for tests). */
  clock?: () => number;
  /** Receives one structured, secret-free summary event. Default: one JSON line on stdout. */
  log?: (event: Record<string, unknown>) => void;
};

export type CleanupResult = {
  orgsDeleted: number;
  usersDeleted: number;
  /** Queued users that turned out not to be eligible (an active demo, a real membership): removed from the queue. */
  usersSkipped: number;
  /** Old guests with no organization queued this run. */
  orphansQueued: number;
  /** Users still queued after this run (failures awaiting retry, or work not reached before the budget ended). */
  retryCandidates: number;
  expiredKeysPurged: number;
  batches: number;
  errors: number;
  errorCodes: string[];
  /** True when the time budget or a stuck batch stopped the run before the work ran out. */
  truncated: boolean;
  durationMs: number;
};

const DEFAULTS = { batchSize: 50, timeBudgetMs: 20_000, orphanMinAgeHours: 48 } as const;

function codeOf(
  error: { code?: string | null; status?: number | null } | null | undefined,
): string {
  if (!error) return "unknown";
  if (error.code) return String(error.code).slice(0, 40);
  if (error.status) return `status_${error.status}`;
  return "unknown";
}

export async function cleanupExpiredDemos(
  admin: AdminClient,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const batchSize = Math.min(
    1000,
    Math.max(1, Math.floor(options.batchSize ?? DEFAULTS.batchSize)),
  );
  const budget = options.timeBudgetMs ?? DEFAULTS.timeBudgetMs;
  const clock = options.clock ?? (() => performance.now());
  const log = options.log ?? ((event) => logger.info(String(event.event ?? "demo_cleanup"), event));
  const started = clock();
  const outOfTime = () => clock() - started >= budget;

  const result: CleanupResult = {
    orgsDeleted: 0,
    usersDeleted: 0,
    usersSkipped: 0,
    orphansQueued: 0,
    retryCandidates: 0,
    expiredKeysPurged: 0,
    batches: 0,
    errors: 0,
    errorCodes: [],
    truncated: false,
    durationMs: 0,
  };
  const codes = new Set<string>();
  const fail = (error: { code?: string | null; status?: number | null } | null | undefined) => {
    result.errors += 1;
    codes.add(codeOf(error));
  };
  const runStart = new Date();

  // Orphans first, so users left behind by an earlier interrupted run are retried too.
  try {
    const orphans = await admin.rpc("cleanup_enqueue_orphans", {
      min_age_hours: options.orphanMinAgeHours ?? DEFAULTS.orphanMinAgeHours,
    });
    if (orphans.error) fail(orphans.error);
    else result.orphansQueued = Number(orphans.data ?? 0);
  } catch {
    fail(null);
  }

  // Phase 1: the database. Independent of phase 2.
  while (true) {
    if (outOfTime()) {
      result.truncated = true;
      break;
    }
    let deleted = 0;
    try {
      const res = await admin.rpc("cleanup_purge_expired_demos", { batch_size: batchSize });
      if (res.error) {
        fail(res.error);
        break;
      }
      deleted = Number((res.data as { orgs_deleted?: number } | null)?.orgs_deleted ?? 0);
    } catch {
      fail(null);
      break;
    }
    result.batches += 1;
    result.orgsDeleted += deleted;
    if (deleted < batchSize) break;
  }

  // Phase 2: the Auth Admin API, one safe user at a time.
  phase2: while (true) {
    if (outOfTime()) {
      result.truncated = true;
      break;
    }
    let ids: string[] = [];
    try {
      const res = await admin.rpc("cleanup_next_users", {
        max_rows: batchSize,
        attempted_before: runStart.toISOString(),
      });
      if (res.error) {
        fail(res.error);
        break;
      }
      ids = (res.data as string[] | null) ?? [];
    } catch {
      fail(null);
      break;
    }
    if (ids.length === 0) break;

    let progressed = 0;
    for (const id of ids) {
      if (outOfTime()) {
        result.truncated = true;
        break phase2;
      }
      try {
        const eligible = await admin.rpc("cleanup_user_eligible", { uid: id });
        if (eligible.error || typeof eligible.data !== "boolean") {
          // Cannot prove it is safe: leave it queued and do not touch the account.
          fail(eligible.error ?? null);
          await admin.rpc("cleanup_record_user", {
            uid: id,
            outcome: "failed",
            error_code: "eligibility_unknown",
          });
          continue;
        }
        if (!eligible.data) {
          await admin.rpc("cleanup_record_user", { uid: id, outcome: "skipped" });
          result.usersSkipped += 1;
          progressed += 1;
          continue;
        }
        const del = await admin.auth.admin.deleteUser(id);
        if (del.error) {
          fail(del.error);
          await admin.rpc("cleanup_record_user", {
            uid: id,
            outcome: "failed",
            error_code: codeOf(del.error),
          });
          continue;
        }
        await admin.rpc("cleanup_record_user", { uid: id, outcome: "deleted" });
        result.usersDeleted += 1;
        progressed += 1;
      } catch (error) {
        fail(error as { code?: string; status?: number });
        try {
          await admin.rpc("cleanup_record_user", {
            uid: id,
            outcome: "failed",
            error_code: "exception",
          });
        } catch {
          /* leave it queued */
        }
      }
    }
    // Everything in this batch failed: stop instead of spinning on the same users; they wait for the next run.
    if (progressed === 0) {
      result.truncated = true;
      break;
    }
  }

  try {
    const keys = await admin.rpc("cleanup_purge_expired_keys");
    if (keys.error) fail(keys.error);
    else result.expiredKeysPurged = Number(keys.data ?? 0);
  } catch {
    fail(null);
  }
  try {
    const size = await admin.rpc("cleanup_queue_size");
    if (!size.error) result.retryCandidates = Number(size.data ?? 0);
  } catch {
    /* informational only */
  }

  result.errorCodes = [...codes].sort();
  result.durationMs = Math.round(clock() - started);
  // Counts and error codes only: no ids, emails or messages.
  log({ event: "demo_cleanup", ...result });
  return result;
}
