/**
 * Link settings for public pages. Unlike `getPublicEnv()`, these never throw: a static page
 * must render with no backend configured (PRD 8.3), so a missing or malformed value falls
 * back to a safe default instead of failing the build.
 */

const DEFAULT_APP_URL = "http://localhost:3000";

export function parseHttpUrl(value: string | undefined): URL | undefined {
  if (!value || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Source code link, or undefined when NEXT_PUBLIC_GITHUB_REPO_URL is unset or not an http(s) URL. */
export function getRepoUrl(value: string | undefined = process.env.NEXT_PUBLIC_GITHUB_REPO_URL) {
  return parseHttpUrl(value)?.toString();
}

/** Site origin for canonical and Open Graph metadata, from NEXT_PUBLIC_APP_URL. */
export function getAppOrigin(value: string | undefined = process.env.NEXT_PUBLIC_APP_URL): URL {
  return parseHttpUrl(value) ?? new URL(DEFAULT_APP_URL);
}
