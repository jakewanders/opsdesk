// The Supabase CLI shells out to `docker`. On macOS, Docker Desktop keeps its CLI in
// ~/.docker/bin and /Applications/Docker.app/..., which are not on PATH by default.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const CANDIDATES = [
  join(homedir(), ".docker", "bin"),
  "/Applications/Docker.app/Contents/Resources/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

/** @param {Record<string, string | undefined>} env @returns {Record<string, string | undefined>} env with Docker's directories on PATH */
export function withDockerPath(env = process.env) {
  const existing = (env.PATH ?? "").split(delimiter);
  const extra = CANDIDATES.filter((dir) => existsSync(dir) && !existing.includes(dir));
  return { ...env, PATH: [...existing, ...extra].join(delimiter) };
}
