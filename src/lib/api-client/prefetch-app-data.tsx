"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiFetch } from "./api-fetch";
import { parseUrlState } from "./url-state";
import { useApi } from "./provider";
import { activityPageUrl, toActivityQuery } from "@/features/activity/filter-state";
import { customerListUrl, toApiQuery as customerQuery } from "@/features/customers/list-state";
import { opportunityPageUrl, toListQuery } from "@/features/opportunities/filter-state";
import { BOARD_KEY, BOARD_PAGE_SIZE } from "@/features/opportunities/use-move-stage";
import { quoteListUrl, toApiQuery as quoteQuery } from "@/features/quotes/list-state";
import { taskListUrl, toApiQuery as taskQuery } from "@/features/tasks/list-state";
import { STAGES } from "@/lib/domain/pipeline";

type Job = { key: unknown[]; path: string; query?: Record<string, string | number | undefined> };

const none = new URLSearchParams();

/**
 * The first read of every tab, exactly as that tab asks for it with no filters in the URL. Keys and queries are built with
 * the views' own helpers so a tab opened later finds its data already in the cache.
 */
export function startupJobs(options: { quotes: boolean }): Job[] {
  const boardBase = { q: undefined, assignedTo: undefined, sort: "updated_at", order: "desc" };
  const jobs: Job[] = [
    { key: ["dashboard"], path: "/dashboard" },
    { key: ["members"], path: "/members" },
    {
      key: ["tasks", taskQuery(parseUrlState(taskListUrl, none))],
      path: "/tasks",
      query: taskQuery(parseUrlState(taskListUrl, none)),
    },
    {
      key: ["customers", customerQuery(parseUrlState(customerListUrl, none))],
      path: "/customers",
      query: customerQuery(parseUrlState(customerListUrl, none)),
    },
    {
      key: ["opportunities-list", toListQuery(parseUrlState(opportunityPageUrl, none))],
      path: "/opportunities",
      query: toListQuery(parseUrlState(opportunityPageUrl, none)),
    },
    {
      key: [...BOARD_KEY, "summary", boardBase],
      path: "/opportunities",
      query: { ...boardBase, limit: 1 },
    },
    ...STAGES.map((stage) => ({
      key: [...BOARD_KEY, "column", stage, boardBase, BOARD_PAGE_SIZE],
      path: "/opportunities",
      query: { ...boardBase, stage, limit: BOARD_PAGE_SIZE },
    })),
    {
      key: ["activity", toActivityQuery(parseUrlState(activityPageUrl, none))],
      path: "/activity",
      query: toActivityQuery(parseUrlState(activityPageUrl, none)),
    },
  ];
  if (options.quotes) {
    const q = quoteQuery(parseUrlState(quoteListUrl, none));
    jobs.push({ key: ["quotes", q], path: "/quotes", query: q });
    // the customer filter on the Quotes tab
    const picker = { limit: 100, sort: "display_name", order: "asc" };
    jobs.push({
      key: ["customers", { picker: "quotes-filter" }],
      path: "/customers",
      query: picker,
    });
  }
  return jobs;
}

/** Starts the reads, a few at a time, skipping anything the cache already holds. Errors are ignored: the tab retries itself. */
export async function prefetchAll(
  client: QueryClient,
  organizationId: string | null,
  jobs: Job[],
  concurrency = 3,
): Promise<void> {
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { key, path, query } = job;
      await client.prefetchQuery({
        queryKey: [organizationId ?? "no-org", ...key],
        queryFn: ({ signal }) => apiFetch(path, { organizationId, query, signal }),
        staleTime: 30_000,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

/** Mount once inside the signed-in app: when it opens, every tab's data is fetched in the background. */
export function PrefetchAppData({ quotes }: { quotes: boolean }) {
  const client = useQueryClient();
  const { organizationId } = useApi();
  useEffect(() => {
    if (!organizationId) return;
    const run = () => void prefetchAll(client, organizationId, startupJobs({ quotes }));
    // after the page the person asked for has had the network to itself for a moment
    const handle = window.setTimeout(run, 300);
    return () => window.clearTimeout(handle);
  }, [client, organizationId, quotes]);
  return null;
}
