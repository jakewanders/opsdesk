import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BadRequestError, ConflictError, ValidationError } from "./errors";
import { mapPostgresError } from "./postgres-errors";
import type { ApiResult } from "./envelope";

/**
 * Idempotency keys (PRD 7.5, SIT-183) for requests whose side effects must not repeat when a client retries:
 * demo bootstrap and reset, quote creation, CSV import commits.
 *
 * The client sends `Idempotency-Key: <8-128 chars of A-Z a-z 0-9 _ ->` (one key per user intent; reuse it on
 * retry, make a new one for a new action). The key is scoped to the signed-in user and the route, and is bound to
 * the request payload: the same key with a different payload is refused (422). Results are kept for 24 hours;
 * an unfinished claim is retaken after 2 minutes.
 *
 * The store (`private.idempotency_keys`) has no client grants; it is reached only through the three SECURITY
 * DEFINER functions `idempotency_begin / complete / abandon`, which act as `auth.uid()`.
 */

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const idempotencyKeySchema = z.string().regex(KEY_PATTERN);

/** The header value, `null` when absent. A malformed key is 422, never silently ignored. */
export function readIdempotencyKey(request: Request): string | null {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError(
      "The Idempotency-Key must be 8 to 128 letters, digits, dashes or underscores.",
      undefined,
      "IDEMPOTENCY_KEY_INVALID",
    );
  }
  return key;
}

/** Same JSON value -> same hash, whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashRequest(payload: unknown): string {
  return createHash("sha256")
    .update(canonical(payload ?? null))
    .digest("hex");
}

type Begin =
  | { state: "new" }
  | { state: "replay"; status: number; body: unknown }
  | { state: "in_progress" }
  | { state: "mismatch" };

export type IdempotencyOptions = {
  /** Stable name of the operation, for example `POST /api/v1/demo/reset`. */
  route: string;
  /** From `readIdempotencyKey`. `null` runs the work once with no replay protection. */
  key: string | null;
  /** Anything that identifies the request's meaning: the validated body and any path params. */
  payload?: unknown;
};

/**
 * Runs `work` at most once per (user, route, key). A replay returns the stored status and body without running
 * `work` again. If `work` throws, the claim is released so the client can retry with the same key.
 *
 * `work` must return a JSON-serializable `ApiResult`; only the status and body are stored.
 */
export async function withIdempotency(
  supabase: SupabaseClient,
  { route, key, payload }: IdempotencyOptions,
  work: () => Promise<ApiResult>,
): Promise<ApiResult> {
  if (key === null) return work();

  const hash = hashRequest(payload);
  const begun = await supabase.rpc("idempotency_begin", {
    p_route: route,
    p_key: key,
    p_hash: hash,
  });
  if (begun.error) throw mapPostgresError(begun.error) ?? begun.error;
  const state = begun.data as Begin;

  switch (state.state) {
    case "replay":
      return {
        __apiResult: true,
        status: state.status as ApiResult["status"],
        body: state.body as ApiResult["body"],
      };
    case "in_progress":
      throw new ConflictError(
        "This request is already being processed. Wait a moment and try again.",
        "IDEMPOTENCY_IN_PROGRESS",
        undefined,
        { "Retry-After": "2" },
      );
    case "mismatch":
      throw new ValidationError(
        "This Idempotency-Key was already used for a different request. Use a new key for a new action.",
        undefined,
        "IDEMPOTENCY_KEY_REUSED",
      );
    case "new":
      break;
    default:
      throw new BadRequestError();
  }

  let result: ApiResult;
  try {
    result = await work();
  } catch (error) {
    await supabase.rpc("idempotency_abandon", { p_route: route, p_key: key });
    throw error;
  }
  const stored = await supabase.rpc("idempotency_complete", {
    p_route: route,
    p_key: key,
    p_status: result.status,
    p_body: (result.body ?? null) as never,
  });
  // The work succeeded; failing to record it must not turn a success into an error. A retry would repeat it
  // only after the 2 minute claim expires, which is the documented trade-off.
  if (stored.error) {
    await supabase.rpc("idempotency_abandon", { p_route: route, p_key: key });
  }
  return result;
}
