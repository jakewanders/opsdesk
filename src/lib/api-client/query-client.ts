import { QueryClient } from "@tanstack/react-query";
import { isClientApiError } from "./api-fetch";

/**
 * One client cache per signed-in user and workspace. It is created fresh when either changes (the provider is
 * remounted with a new key), so nothing cached for one user or workspace can appear for another.
 *
 * Defaults: data is fresh for 30 seconds and kept 5 minutes after the last use; a request that failed because of
 * the caller (4xx) is never retried, a transient failure (no answer, 5xx) at most twice; mutations never retry
 * (a retry of a write is the caller's decision, with its idempotency key).
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) =>
          failureCount < 2 && (!isClientApiError(error) || error.isTransient),
      },
      mutations: { retry: false },
    },
  });
}
