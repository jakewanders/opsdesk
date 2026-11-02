import type { FeatureFlags } from "@/lib/env/schema";

/**
 * Flip to true in the quotes UI issue, when `/api/v1/quotes` exists and the customer page has a quotes list to show. Until
 * then the Quotes tab is never rendered, whatever the flag says: no broken or empty placeholder tab.
 */
export const QUOTES_API_AVAILABLE = false;

/** The customer page shows a Quotes tab only when the feature flag is on AND the quotes API exists. */
export function quotesTabEnabled(flags: Pick<FeatureFlags, "quotes">): boolean {
  return flags.quotes && QUOTES_API_AVAILABLE;
}
