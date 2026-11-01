// Guards destructive local database commands: refuse anything that could reach a remote database.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);
const ENV_URL_KEYS = [
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
];
const FORBIDDEN_FLAGS = ["--linked", "--db-url"];

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} argv
 * @returns {string[]} reasons to refuse; empty means the target is local
 */
export function localDbViolations(env, argv = []) {
  const problems = [];
  for (const flag of FORBIDDEN_FLAGS) {
    if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
      problems.push(`${flag} targets a remote database`);
    }
  }
  for (const key of ENV_URL_KEYS) {
    const value = env[key];
    if (!value) continue;
    const host = hostOf(value);
    if (host === null) {
      problems.push(`${key} is not a valid URL`);
    } else if (!LOCAL_HOSTS.has(host)) {
      problems.push(`${key} points at non-local host "${host}"`);
    }
  }
  return problems;
}
