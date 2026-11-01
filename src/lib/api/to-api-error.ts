import { ZodError } from "zod";
import { ApiError, InternalError, ValidationError } from "./errors";
import { mapPostgresError } from "./postgres-errors";
import type { FieldErrors } from "./types";

/** Zod issues to `{ "field.path": ["message", ...] }`. Issues with no path go under `_form`. */
export function zodFieldErrors(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_form";
    (fields[key] ??= []).push(issue.message);
  }
  return fields;
}

/**
 * Converts anything a handler can throw into an `ApiError`. Order: our own errors, Zod
 * validation, recognized database errors, then a generic 500. The original error is returned
 * separately so the caller can log it server-side; it is never sent to the client.
 */
export function toApiError(error: unknown): { apiError: ApiError; unexpected: boolean } {
  if (error instanceof ApiError) return { apiError: error, unexpected: error.status >= 500 };
  if (error instanceof ZodError) {
    return { apiError: new ValidationError(undefined, zodFieldErrors(error)), unexpected: false };
  }
  const mapped = mapPostgresError(error);
  if (mapped) return { apiError: mapped, unexpected: mapped.status >= 500 };
  return { apiError: new InternalError(), unexpected: true };
}
