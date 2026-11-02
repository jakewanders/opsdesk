"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { useApi } from "./provider";
import { newIdempotencyKey } from "./idempotency";
import type { ApiFetchOptions, ApiResponse } from "./api-fetch";

type Call = <T>(path: string, options?: ApiFetchOptions) => Promise<ApiResponse<T>>;

type Options<TData, TVars, TCache> = {
  /** Performs the write. `call` already carries the workspace header; `key` is the idempotency key when enabled. */
  mutationFn: (
    vars: TVars,
    ctx: { call: Call; key: string | undefined },
  ) => Promise<ApiResponse<TData>>;
  /** Send an `Idempotency-Key`: one per intent, reused when the same intent is retried after a failure. */
  idempotent?: boolean;
  /**
   * Optimistic update of one cached query: `update` returns the new cache value from the old one. On any error the
   * previous value is put back (rollback); on settle the query is refetched so the server has the last word.
   */
  optimistic?: { key: QueryKey; update: (old: TCache, vars: TVars) => TCache };
  /** Queries to refetch when the write settles. */
  invalidate?: QueryKey[];
};

/**
 * The one mutation helper. It (1) ignores a second call while one is pending (double-submit), (2) can send an
 * idempotency key that survives a failed attempt and is dropped on success, and (3) supports optimistic updates with
 * rollback.
 */
export function useApiMutation<TData, TVars = void, TCache = unknown>(
  options: Options<TData, TVars, TCache>,
) {
  const { fetch: call, organizationId } = useApi();
  const queryClient = useQueryClient();
  const idempotencyKey = useRef<string | undefined>(undefined);
  const inFlight = useRef<Promise<ApiResponse<TData>> | null>(null);
  /** Keys are scoped to the workspace exactly as `useApiQuery` scopes them. */
  const scope = (k: QueryKey): QueryKey => [organizationId ?? "no-org", ...k];

  const mutation = useMutation<
    ApiResponse<TData>,
    Error,
    TVars,
    { previous: unknown; key: QueryKey | null }
  >({
    mutationFn: (vars) => {
      if (options.idempotent) idempotencyKey.current ??= newIdempotencyKey();
      return options.mutationFn(vars, { call, key: idempotencyKey.current });
    },
    onMutate: async (vars) => {
      if (!options.optimistic) return { previous: undefined, key: null };
      const key = scope(options.optimistic.key);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      // The cache holds the API response, so the update works on its `data`. Nothing cached means nothing to update.
      queryClient.setQueryData(key, (old: ApiResponse<TCache> | undefined) =>
        old ? { ...old, data: options.optimistic!.update(old.data, vars) } : old,
      );
      return { previous, key };
    },
    onError: (_error, _vars, context) => {
      if (context?.key) queryClient.setQueryData(context.key, context.previous);
    },
    onSuccess: () => {
      idempotencyKey.current = undefined; // the next call is a new intent
    },
    onSettled: async (_data, _error, _vars, context) => {
      const keys = [
        ...(context?.key ? [context.key] : []),
        ...(options.invalidate ?? []).map(scope),
      ];
      await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
    },
  });

  const mutateAsync = useCallback(
    (vars: TVars) => {
      if (inFlight.current) return inFlight.current; // double click: same promise, one request
      const run = mutation.mutateAsync(vars).finally(() => {
        inFlight.current = null;
      });
      inFlight.current = run;
      return run;
    },
    [mutation],
  );

  return {
    mutateAsync,
    mutate: (vars: TVars) => {
      mutateAsync(vars).catch(() => undefined); // the error is on `error`; callers that care use mutateAsync
    },
    isPending: mutation.isPending,
    error: mutation.error,
    reset: mutation.reset,
  };
}
