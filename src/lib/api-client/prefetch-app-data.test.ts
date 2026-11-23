import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { prefetchAll, startupJobs } from "./prefetch-app-data";

describe("startup prefetch", () => {
  it("covers every tab, and quotes only while they are on", () => {
    const paths = (quotes: boolean) => new Set(startupJobs({ quotes }).map((j) => j.path));
    for (const p of [
      "/dashboard",
      "/members",
      "/tasks",
      "/customers",
      "/opportunities",
      "/activity",
    ])
      expect(paths(false)).toContain(p);
    expect(paths(false)).not.toContain("/quotes");
    expect(paths(true)).toContain("/quotes");
  });

  it("asks for one column per stage on the pipeline board", () => {
    const columns = startupJobs({ quotes: false }).filter((j) => j.key[1] === "column");
    expect(columns.map((j) => j.key[2])).toEqual([
      "new",
      "qualified",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ]);
  });

  it("stores each answer under the workspace-scoped key a view would use, and does not read a fresh entry twice", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [], meta: {} }, { headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient();
    const jobs = startupJobs({ quotes: true });
    await prefetchAll(client, "org-1", jobs);
    expect(client.getQueryData(["org-1", "dashboard"])).toBeDefined();
    expect(client.getQueryData(["org-1", "members"])).toBeDefined();
    const reads = fetchMock.mock.calls.length;
    expect(reads).toBe(jobs.length);
    await prefetchAll(client, "org-1", jobs);
    expect(fetchMock.mock.calls.length).toBe(reads);
    vi.unstubAllGlobals();
  });
});
