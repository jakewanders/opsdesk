"use client";

import {
  keepPreviousData,
  QueryClientProvider,
  useQuery,
  type QueryKey,
} from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import "@/lib/zod-browser-config";
import { apiFetch, type ApiFetchOptions, type ApiResponse } from "./api-fetch";
import { makeQueryClient } from "./query-client";

type ApiContextValue = {
  organizationId: string | null;
  clearCache: () => void;
};

const ApiContext = createContext<ApiContextValue | null>(null);

type ProviderProps = {
  /** The active workspace. The cache belongs to it: mount this with `key={organizationId}` so a switch starts clean. */
  organizationId: string | null;
  children: ReactNode;
};

/**
 * The single client data system. Server Components do the first secured read; interactive reads and every mutation
 * go through here. Clearing happens three ways: switching workspace (the provider remounts with a new key and
 * creates a new cache), signing out (`useClearApiCache`), and leaving `/app` (the provider unmounts with the layout).
 */
export function ApiClientProvider({ organizationId, children }: ProviderProps) {
  const [client] = useState(makeQueryClient);
  const clearCache = useCallback(() => client.clear(), [client]);
  const value = useMemo(() => ({ organizationId, clearCache }), [organizationId, clearCache]);
  return (
    <QueryClientProvider client={client}>
      <ApiContext.Provider value={value}>{children}</ApiContext.Provider>
    </QueryClientProvider>
  );
}

function useApiContext(): ApiContextValue {
  const ctx = useContext(ApiContext);
  if (!ctx) throw new Error("useApi must be used inside <ApiClientProvider>.");
  return ctx;
}

/** Drops every cached query and mutation. Call it when the user signs out. A no-op outside the provider. */
export function useClearApiCache(): () => void {
  return useContext(ApiContext)?.clearCache ?? (() => undefined);
}

/** `apiFetch` bound to the active workspace (sends `X-Organization-Id`). */
export function useApi() {
  const { organizationId } = useApiContext();
  const call = useCallback(
    <T,>(path: string, options: ApiFetchOptions = {}) =>
      apiFetch<T>(path, { organizationId, ...options }),
    [organizationId],
  );
  return { organizationId, fetch: call };
}

/** Query keys are scoped to the workspace, so two workspaces never share an entry even in one cache. */
export function useScopedKey(key: QueryKey): QueryKey {
  const { organizationId } = useApiContext();
  return useMemo(() => [organizationId ?? "no-org", ...key], [organizationId, key]);
}

type QueryOptions<T> = {
  query?: ApiFetchOptions["query"];
  enabled?: boolean;
  staleTime?: number;
  /** Server-rendered first read, so the first paint needs no request. */
  initialData?: ApiResponse<T>;
  /** Keep showing the previous result while a new key loads (paging, filtering) instead of an empty table. */
  keepPrevious?: boolean;
};

/** A GET through the shared cache. */
export function useApiQuery<T>(key: QueryKey, path: string, options: QueryOptions<T> = {}) {
  const { fetch: call } = useApi();
  const scoped = useScopedKey(key);
  return useQuery<ApiResponse<T>>({
    queryKey: scoped,
    queryFn: ({ signal }) => call<T>(path, { query: options.query, signal }),
    enabled: options.enabled,
    staleTime: options.staleTime,
    initialData: options.initialData,
    placeholderData: options.keepPrevious ? keepPreviousData : undefined,
  });
}
