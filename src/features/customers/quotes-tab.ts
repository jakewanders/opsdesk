import type { FeatureFlags } from "@/lib/env/schema";

/** `/api/v1/quotes` exists and the customer page has a quotes list to show (SIT-246), so the tab follows the feature flag. */
export const QUOTES_API_AVAILABLE = true;

/** The customer page shows a Quotes tab only when the feature flag is on AND the quotes API exists. */
export function quotesTabEnabled(flags: Pick<FeatureFlags, "quotes">): boolean {
  return flags.quotes && QUOTES_API_AVAILABLE;
}
