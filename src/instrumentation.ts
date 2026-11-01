// Runs once when the Next.js server starts. A missing or malformed variable stops startup
// with a readable message instead of failing later inside a request.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertEnv } = await import("@/lib/env/server");
    assertEnv();
  }
}
