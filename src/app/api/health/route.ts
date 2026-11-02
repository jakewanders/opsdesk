import { RateLimitError } from "@/lib/api/errors";
import { withApi } from "@/lib/api/handler";
import { checkHealth } from "@/lib/health/check";
import { clientKey, createRateLimiter } from "@/lib/http/rate-limit";

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/**
 * GET /api/health: `{ web: "ok", database: "ok" | "unavailable" }`. No authentication, never cached, rate limited
 * (30 a minute per address). The status is 200 whenever the web app answers: the body says whether the database does,
 * so a monitor or the status badge can tell "site up, backend paused" from "site down". No details, no secrets.
 */
export const GET = withApi(
  async ({ request }) => {
    const { allowed, retryAfterSeconds } = limiter.hit(clientKey(request.headers));
    if (!allowed)
      throw new RateLimitError("Too many health checks. Try again shortly.", retryAfterSeconds);
    const status = await checkHealth({
      // Bracket access is read at request time and never inlined by the build, so the running server's settings win.
      supabaseUrl: process.env["NEXT_PUBLIC_SUPABASE_URL"],
      publishableKey: process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
    });
    return Response.json(status);
  },
  { auth: "none" },
);
