/**
 * Interim server-side error log for the API layer. One JSON line per unexpected failure with the
 * request ID, the error's name and database code, and a truncated message, so an operator can
 * find the cause from the ID a user quotes. The structured, redacting logger (SIT-185) replaces
 * this; until then nothing sensitive is logged here: no request body, headers, or cookies.
 */
export function logUnexpectedError(requestId: string, error: unknown): void {
  const err = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const line = {
    level: "error",
    event: "api.unhandled_error",
    requestId,
    errorName: typeof err?.name === "string" ? err.name : typeof error,
    errorCode: typeof err?.code === "string" ? err.code : undefined,
    message: typeof err?.message === "string" ? err.message.slice(0, 500) : undefined,
  };
  console.error(JSON.stringify(line));
}
