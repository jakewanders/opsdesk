import { execFileSync } from "node:child_process";
import { withDockerPath } from "../../scripts/lib/docker-path.mjs";

/**
 * Helpers for integration tests against the LOCAL Supabase stack. They refuse to run against
 * anything but 127.0.0.1 / localhost and read the local keys from the CLI at run time.
 */
export type LocalSupabase = { apiUrl: string; publishableKey: string; secretKey: string };

const DB_CONTAINER = "supabase_db_opsdesk";

export function localSupabase(): LocalSupabase {
  let json: string;
  try {
    json = execFileSync("npx", ["supabase", "status", "-o", "json"], {
      env: withDockerPath() as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("The local Supabase stack is not running. Start it with `npm run db:start`.");
  }
  const status = JSON.parse(json.slice(json.indexOf("{"))) as Record<string, string>;
  const apiUrl = status.API_URL;
  const host = new URL(apiUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run integration tests against non-local host "${host}".`);
  }
  return { apiUrl, publishableKey: status.PUBLISHABLE_KEY, secretKey: status.SECRET_KEY };
}

/** Runs SQL as the postgres superuser inside the local database container; returns rows as text. */
export function psql(sql: string): string {
  return execFileSync(
    "docker",
    ["exec", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql],
    { env: withDockerPath() as NodeJS.ProcessEnv, encoding: "utf8" },
  ).trim();
}
