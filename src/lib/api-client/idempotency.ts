/**
 * Client side of idempotency (SIT-183): one key per user intent, reused on every retry of that intent and
 * dropped once it succeeds, plus a guard that refuses a second submit while the first is pending.
 * The typed API client (SIT-184) builds on these.
 */

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export type SingleFlight<T> = {
  /** Runs `send(key)`; while it is pending a second call is ignored and resolves to the first call's promise. */
  run(send: (key: string) => Promise<T>): Promise<T>;
  readonly pending: boolean;
  /** The key a retry would reuse, or null when the last intent finished. */
  readonly key: string | null;
};

/**
 * Wraps one form or button. A failed attempt keeps its key, so clicking again sends the same key and the server
 * returns the original result instead of repeating the work. A success clears the key; the next click is a new
 * action with a new key.
 */
export function createSingleFlight<T>(makeKey: () => string = newIdempotencyKey): SingleFlight<T> {
  let key: string | null = null;
  let inFlight: Promise<T> | null = null;
  return {
    run(send) {
      if (inFlight) return inFlight;
      key ??= makeKey();
      const attempt = send(key).then(
        (value) => {
          key = null;
          return value;
        },
        (error: unknown) => {
          throw error;
        },
      );
      inFlight = attempt.finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get pending() {
      return inFlight !== null;
    },
    get key() {
      return key;
    },
  };
}
