import { z } from "zod";
import { ValidationError } from "@/lib/api/errors";
import { zodFieldErrors } from "@/lib/api/to-api-error";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

const positiveInt = (name: string, max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, `${name} must be a whole number.`)
    .transform(Number)
    .pipe(
      z.number().min(1, `${name} must be 1 or more.`).max(max, `${name} must be ${max} or less.`),
    );

/**
 * Builds the query schema for a list endpoint: `page` (>= 1, default 1), `limit` (default 25, **a value
 * over 100 is rejected with 422, never silently clamped**, so a client always knows what it got),
 * `sort` limited to a per-endpoint whitelist, `order` asc/desc, plus the endpoint's own filters.
 *
 * Unknown parameters are rejected. `sort` is an enum of the whitelist, so no client text ever reaches an
 * ORDER BY clause: map the validated key to a column with a constant record at the call site.
 */
export function listQuery<
  const S extends readonly [string, ...string[]],
  F extends z.ZodRawShape = Record<string, never>,
>(config: {
  sortable: S;
  defaultSort: S[number];
  defaultOrder?: "asc" | "desc";
  filters?: F;
  /** Pairs of filters that bound a range, for example `["closeFrom", "closeTo"]`: when both are given the second must not be before the first (422 on the second). */
  ranges?: ReadonlyArray<readonly [from: keyof F & string, to: keyof F & string]>;
}) {
  const object = z.strictObject({
    page: positiveInt("page", 1_000_000).default(1),
    limit: positiveInt("limit", MAX_LIMIT).default(DEFAULT_LIMIT),
    sort: z
      .enum(config.sortable, { error: `Sort by one of: ${config.sortable.join(", ")}.` })
      .default(config.defaultSort),
    order: z
      .enum(["asc", "desc"], { error: "Order must be asc or desc." })
      .default(config.defaultOrder ?? "desc"),
    ...((config.filters ?? {}) as F),
  });
  return object.superRefine((value, ctx) => {
    const v = value as Record<string, unknown>;
    for (const [from, to] of config.ranges ?? []) {
      const a = v[from];
      const b = v[to];
      if (a !== undefined && b !== undefined && (a as number | string) > (b as number | string)) {
        ctx.addIssue({
          code: "custom",
          path: [to],
          message: `This must not be before ${from}.`,
        });
      }
    }
  });
}

/** Query-string text to a plain object. A repeated key becomes an array, which scalar schemas then refuse. */
export function searchParamsToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else out[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  return out;
}

/**
 * Validates `searchParams` against a schema. Empty values (`?q=`) count as absent. Failure is a 422
 * with `fieldErrors` keyed by parameter name.
 */
export function parseQuery<T extends z.ZodType>(
  schema: T,
  searchParams: URLSearchParams | string,
): z.output<T> {
  const params =
    typeof searchParams === "string" ? new URLSearchParams(searchParams) : searchParams;
  const raw = searchParamsToObject(params);
  for (const key of Object.keys(raw)) if (raw[key] === "") delete raw[key];
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError("Some filters are not valid.", zodFieldErrors(result.error));
  }
  return result.data;
}
