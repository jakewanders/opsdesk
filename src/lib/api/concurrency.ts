import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ConflictError, NotFoundError } from "./errors";

/**
 * Optimistic concurrency (PRD 7.5, SIT-183).
 *
 * Decision: CRM entities compare `updated_at` (kept current by `private.set_updated_at`); entities that need a
 * monotonic counter (quotes) carry an integer `version` kept by `private.bump_version`. Either way the client
 * sends back what it last saw and the UPDATE only matches that exact state:
 *
 *   UPDATE ... WHERE id = $1 AND updated_at = $2   -- or  AND version = $2
 *
 * Zero rows back means the record changed (409 with the current value in `error.meta.current`) or is not
 * visible to the caller (404, indistinguishable from another tenant's record).
 *
 * Timestamps are compared as the opaque strings the API returned: PostgREST keeps microseconds, a JavaScript
 * `Date` does not, so never round-trip `updatedAt` through `new Date()`.
 */

/** Body field for entities that compare `updated_at`. */
export const expectedUpdatedAtSchema = z
  .string({ error: "Reload the record and try again." })
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/,
    "Reload the record and try again.",
  );

/** Body field for entities that carry a `version` (quotes). */
export const expectedVersionSchema = z
  .number({ error: "Reload the record and try again." })
  .int("Reload the record and try again.")
  .min(1, "Reload the record and try again.");

/** Spread into an update schema: `z.strictObject({ ...fields, ...expectedUpdatedAtField })`. */
export const expectedUpdatedAtField = { expectedUpdatedAt: expectedUpdatedAtSchema } as const;
export const expectedVersionField = { expectedVersion: expectedVersionSchema } as const;

export type Expected = { updatedAt: string } | { version: number };
export type CurrentVersion = { updatedAt: string; version?: number };

/** 409 for a stale edit. The client shows "changed by someone else" and offers a reload using `meta.current`. */
export class StaleEditError extends ConflictError {
  constructor(public readonly current: CurrentVersion) {
    super(
      "This record was changed by someone else since you opened it. Reload to see the latest version, then try again.",
      "STALE_EDIT",
      { current },
    );
  }
}

type Row = Record<string, unknown>;

export type UpdateIfCurrentOptions = {
  table: string;
  id: string;
  expected: Expected;
  /** Columns to change. Never include `id`, `organization_id`, `version` or `updated_at`. */
  patch: Record<string, unknown>;
  /** Columns to return, PostgREST syntax. Default `*`. */
  columns?: string;
};

/**
 * Runs the compare-and-set update and returns the updated row. Throws `StaleEditError` when the record exists but
 * is no longer in the state the client saw, and `NotFoundError` when the caller cannot see it at all.
 *
 * Authorization is NOT decided here: check the caller's role first (permission matrix); RLS still applies, and a
 * row the caller may read but not write also comes back as zero rows.
 */
export async function updateIfCurrent(
  supabase: SupabaseClient,
  { table, id, expected, patch, columns = "*" }: UpdateIfCurrentOptions,
): Promise<Row> {
  const query = supabase.from(table).update(patch).eq("id", id);
  const matched =
    "version" in expected
      ? query.eq("version", expected.version)
      : query.eq("updated_at", expected.updatedAt);
  const { data, error } = await matched.select(columns).maybeSingle();
  if (error) throw error;
  if (data) return data as unknown as Row;

  const withVersion = "version" in expected;
  const current = await supabase
    .from(table)
    .select(withVersion ? "updated_at, version" : "updated_at")
    .eq("id", id)
    .maybeSingle();
  if (current.error) throw current.error;
  if (!current.data) throw new NotFoundError();
  const row = current.data as unknown as { updated_at: string; version?: number };
  throw new StaleEditError({
    updatedAt: row.updated_at,
    ...(row.version === undefined ? {} : { version: row.version }),
  });
}
