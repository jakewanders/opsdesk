/**
 * A small fixed-window rate limiter for public endpoints. State lives in process memory, so on serverless hosting each
 * warm instance counts separately: it is a guard against a runaway client or a loop, not a security boundary (the
 * platform's own limits and the database-side caps are). The map is bounded so it cannot grow without limit.
 */
export type RateLimiter = {
  /** Records a hit for `key`. `allowed` is false once the window's budget is spent. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
};

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const { limit, windowMs, maxKeys = 5000, now = Date.now } = options;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= windowMs) {
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (t - v.start >= windowMs) windows.delete(k);
          if (windows.size >= maxKeys) windows.delete(windows.keys().next().value as string);
        }
        w = { start: t, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      return {
        allowed: w.count <= limit,
        retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - t) / 1000)),
      };
    },
  };
}

/** The caller's address as the platform reports it (Netlify, then proxies), or "unknown". */
export function clientKey(headers: Headers): string {
  const direct = headers.get("x-nf-client-connection-ip") ?? headers.get("x-real-ip");
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (direct ?? forwarded ?? "unknown").slice(0, 64);
}
