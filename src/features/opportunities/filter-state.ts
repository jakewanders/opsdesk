import { defineUrlState, urlField, type UrlState } from "@/lib/api-client/url-state";

/**
 * The filters the pipeline board and the opportunity list share (US-04): the same URL parameters, so switching between
 * the two views keeps the search and the owner. They are also the API's own query parameter names.
 */
export const opportunityFilterUrl = defineUrlState({
  q: urlField.string("", 100),
  assignedTo: urlField.string("", 36),
});
export type OpportunityFilterState = UrlState<typeof opportunityFilterUrl>;
