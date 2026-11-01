/**
 * Netlify sets CONTEXT to "production", "deploy-preview", "branch-deploy", or "dev". Only the
 * production deploy may be indexed (PRD 10.2 item 9). When CONTEXT is absent (local dev, CI)
 * the header is not added.
 */
export function shouldNoindex(context: string | undefined): boolean {
  return Boolean(context) && context !== "production";
}

export const NOINDEX_VALUE = "noindex, nofollow";
