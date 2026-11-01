import {
  ApiError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from "./errors";

/** The fields Supabase (PostgREST) and node-postgres put on a database error. */
type DbErrorLike = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,40}$/;

/**
 * Convention for SQL authors (RPCs and triggers): to refuse a request on purpose with a message
 * that is safe to show, raise a custom SQLSTATE in the `OD` class:
 *
 *   raise exception using errcode = 'OD429', message = 'Demo limit reached: customers.',
 *                         detail = 'DEMO_QUOTA', hint = 'retry-after=60';
 *
 * | SQLSTATE | HTTP | Use for |
 * | -------- | ---- | ------- |
 * | OD403    | 403  | the caller may not do this (guest, wrong role) |
 * | OD404    | 404  | record missing, or in another tenant |
 * | OD409    | 409  | stale edit, state conflict |
 * | OD422    | 422  | a business rule refuses it |
 * | OD429    | 429  | quota or throttle |
 *
 * `message` is shown to the user, so it must be written for them. `detail` (optional) is a
 * machine code, UPPER_SNAKE_CASE, returned as the error `code`. `hint` may carry `retry-after=N`.
 * Every other database error is mapped with a fixed message and never exposes SQL text.
 */
function mapCustom(sqlstate: string, error: DbErrorLike): ApiError | null {
  const message =
    typeof error.message === "string" && error.message.trim() !== "" ? error.message : undefined;
  const detail =
    typeof error.details === "string" && CODE_PATTERN.test(error.details)
      ? error.details
      : undefined;
  switch (sqlstate) {
    case "OD403":
      return new ForbiddenError(message, detail);
    case "OD404":
      return new NotFoundError(message, detail);
    case "OD409":
      return new ConflictError(message, detail);
    case "OD422":
      return new ValidationError(message, undefined, detail);
    case "OD429": {
      const retry =
        typeof error.hint === "string" ? /retry-after=(\d{1,6})/.exec(error.hint) : null;
      return new RateLimitError(message, retry ? Number(retry[1]) : undefined, detail);
    }
    default:
      return null;
  }
}

/**
 * Maps a database error to an `ApiError`, or null when it is not one we recognize (the caller
 * then treats it as an unexpected 500). Messages are fixed text: constraint, table, column, and
 * value names from Postgres never leave the server.
 */
export function mapPostgresError(error: unknown): ApiError | null {
  if (typeof error !== "object" || error === null) return null;
  const db = error as DbErrorLike;
  if (typeof db.code !== "string") return null;
  const code = db.code;

  if (/^OD\d{3}$/.test(code)) return mapCustom(code, db);

  switch (code) {
    // Integrity constraints (class 23)
    case "23505": // unique_violation
      return new ConflictError("A record with these details already exists.", "DUPLICATE");
    case "23503": // foreign_key_violation (including cross-tenant references)
      return new ValidationError(
        "A referenced record does not exist.",
        undefined,
        "INVALID_REFERENCE",
      );
    case "23514": // check_violation
      return new ValidationError(
        "A value is outside the allowed range or format.",
        undefined,
        "CHECK_VIOLATION",
      );
    case "23502": // not_null_violation
      return new ValidationError("A required value is missing.", undefined, "REQUIRED_VALUE");
    case "23P01": // exclusion_violation
      return new ConflictError("This conflicts with an existing record.", "CONFLICT");

    // Data exceptions (class 22)
    case "22001": // string_data_right_truncation
      return new ValidationError("A value is too long.", undefined, "VALUE_TOO_LONG");
    case "22003": // numeric_value_out_of_range
      return new ValidationError("A number is out of range.", undefined, "VALUE_OUT_OF_RANGE");
    case "22P02": // invalid_text_representation (for example a malformed UUID)
    case "22007": // invalid_datetime_format
    case "22008": // datetime_field_overflow
      return new BadRequestError("A value has the wrong format.");

    // Privileges: grants, and row level security on writes
    case "42501": // insufficient_privilege
      return new ForbiddenError();

    // PostgREST
    case "PGRST116": // a single row was requested and none (or several) matched
      return new NotFoundError();
    case "PGRST301": // JWT expired
    case "PGRST303": // JWT invalid
      return new UnauthorizedError();

    default:
      return null;
  }
}
