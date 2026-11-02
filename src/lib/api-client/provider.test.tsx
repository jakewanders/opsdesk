import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "./api-fetch";
import { ApiClientProvider, useApi, useApiQuery, useClearApiCache } from "./provider";
import { useApiMutation } from "./use-api-mutation";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
const ok = (data: unknown) => json(200, { data, meta: {} });

let fetchSpy: ReturnType<typeof vi.spyOn>;
afterEach(() => vi.restoreAllMocks());
const mockFetch = (impl: (url: string, init: RequestInit) => Promise<Response>) =>
  (fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((u, i) => impl(String(u), i ?? {})));

const wrapper = (orgId: string | null) =>
  function W({ children }: { children: ReactNode }) {
    return <ApiClientProvider organizationId={orgId}>{children}</ApiClientProvider>;
  };

function Probe({ id }: { id?: string }) {
  const qc = useQueryClient();
  const q = useApiQuery<{ n: number }>(["things"], "/things");
  return (
    <div>
      <span data-testid="data">{q.data ? q.data.data.n : "none"}</span>
      <span data-testid="count">{qc.getQueryCache().getAll().length}</span>
      <span>{id}</span>
    </div>
  );
}

describe("workspace scoping and cache clearing", () => {
  it("sends the active workspace on every request", async () => {
    mockFetch(async () => ok({ n: 1 }));
    render(
      <ApiClientProvider organizationId="org-A">
        <Probe />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("1"));
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({ "X-Organization-Id": "org-A" });
  });

  it("switching workspace (provider remounted with a new key) starts with an empty cache and refetches", async () => {
    let n = 0;
    mockFetch(async () => ok({ n: ++n }));
    const { rerender } = render(
      <ApiClientProvider key="u:A" organizationId="A">
        <Probe />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("1"));
    rerender(
      <ApiClientProvider key="u:B" organizationId="B">
        <Probe />
      </ApiClientProvider>,
    );
    // not the previous workspace's data, even for an instant
    expect(screen.getByTestId("data")).toHaveTextContent("none");
    await waitFor(() => expect(screen.getByTestId("data")).toHaveTextContent("2"));
    const headers = (fetchSpy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Organization-Id"]).toBe("B");
  });

  it("signing out clears every cached query", async () => {
    mockFetch(async () => ok({ n: 1 }));
    function Out() {
      const clear = useClearApiCache();
      return <button onClick={clear}>sign out</button>;
    }
    const grabbed: { client?: ReturnType<typeof useQueryClient> } = {};
    function Grab() {
      const qc = useQueryClient();
      useEffect(() => {
        grabbed.client = qc;
      });
      return null;
    }
    render(
      <ApiClientProvider organizationId="A">
        <Probe />
        <Out />
        <Grab />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(grabbed.client?.getQueryData(["A", "things"])).toBeDefined());
    await userEvent.click(screen.getByRole("button", { name: "sign out" }));
    expect(grabbed.client!.getQueryCache().getAll()).toHaveLength(0);
    expect(grabbed.client!.getQueryData(["A", "things"])).toBeUndefined();
  });

  it("cache keys are scoped to the workspace", async () => {
    mockFetch(async () => ok({ n: 1 }));
    const grabbed: { client?: ReturnType<typeof useQueryClient> } = {};
    function K() {
      useApiQuery(["a"], "/a");
      const qc = useQueryClient();
      useEffect(() => {
        grabbed.client = qc;
      });
      return null;
    }
    render(
      <ApiClientProvider organizationId="org-9">
        <K />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(grabbed.client?.getQueryData(["org-9", "a"])).toBeDefined());
    expect(
      grabbed
        .client!.getQueryCache()
        .getAll()
        .map((q) => q.queryKey),
    ).toEqual([["org-9", "a"]]);
  });

  it("useClearApiCache is a safe no-op outside the provider, useApi throws a clear error", () => {
    const { result } = renderHook(() => useClearApiCache());
    expect(() => result.current()).not.toThrow();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => renderHook(() => useApi())).toThrow(/ApiClientProvider/);
    spy.mockRestore();
  });
});

describe("query retry policy", () => {
  it("does not retry a 4xx (the caller's fault) and surfaces a typed error", async () => {
    mockFetch(async () =>
      json(404, { error: { code: "NOT_FOUND", message: "nope", requestId: "r" } }),
    );
    const { result } = renderHook(() => useApiQuery(["x"], "/x"), { wrapper: wrapper("A") });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeInstanceOf(ClientApiError);
  });
});

describe("useApiMutation", () => {
  const useCreate = (
    over: Partial<Parameters<typeof useApiMutation<{ id: string }, string, string[]>>[0]> = {},
  ) =>
    useApiMutation<{ id: string }, string, string[]>({
      mutationFn: (name, { call, key }) =>
        call("/things", { method: "POST", json: { name }, idempotencyKey: key }),
      ...over,
    });

  it("ignores a second submit while the first is pending: one request, one promise", async () => {
    let release: (() => void) | undefined;
    mockFetch(() => new Promise<Response>((r) => (release = () => r(ok({ id: "1" })))));
    const { result } = renderHook(() => useCreate(), { wrapper: wrapper("A") });
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.mutateAsync("x");
      b = result.current.mutateAsync("x");
    });
    expect(a).toBe(b);
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release!();
    await act(async () => void (await a));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("idempotent: the same key is reused when a failed attempt is retried, and a new one is used after success", async () => {
    const keys: string[] = [];
    let call = 0;
    mockFetch(async (_u, init) => {
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
      return ++call === 1
        ? json(500, { error: { code: "INTERNAL_ERROR", message: "x" } })
        : ok({ id: "1" });
    });
    const { result } = renderHook(() => useCreate({ idempotent: true }), { wrapper: wrapper("A") });
    await act(async () => void (await result.current.mutateAsync("x").catch(() => undefined)));
    await act(async () => void (await result.current.mutateAsync("x")));
    await act(async () => void (await result.current.mutateAsync("y")));
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("without idempotent no key is sent", async () => {
    mockFetch(async () => ok({ id: "1" }));
    const { result } = renderHook(() => useCreate(), { wrapper: wrapper("A") });
    await act(async () => void (await result.current.mutateAsync("x")));
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty(
      "Idempotency-Key",
    );
  });

  function useListAndCreate(over: Parameters<typeof useCreate>[0] = {}) {
    const list = useApiQuery<string[]>(["things"], "/things");
    const create = useCreate({
      optimistic: { key: ["things"], update: (old, name) => [...old, name] },
      ...over,
    });
    return { list, create };
  }

  it("optimistic update shows the change at once and the server's answer replaces it", async () => {
    let serverList = ["a"];
    let release!: () => void;
    mockFetch(async (_u, init) => {
      if (init.method === "POST") {
        await new Promise<void>((r) => (release = r));
        serverList = [...serverList, "b"];
        return ok({ id: "2" });
      }
      return ok(serverList);
    });
    const { result } = renderHook(() => useListAndCreate(), { wrapper: wrapper("A") });
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["a"]));
    let p!: Promise<unknown>;
    act(() => void (p = result.current.create.mutateAsync("b")));
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["a", "b"]));
    await waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await act(async () => void (await p));
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["a", "b"]));
  });

  it("rolls back the optimistic update when the write fails (before any refetch can mask it)", async () => {
    let gets = 0;
    mockFetch(async (_u, init) => {
      if (init.method === "POST")
        return json(422, { error: { code: "VALIDATION_ERROR", message: "bad", requestId: "r" } });
      gets += 1;
      // the refetch after the failure never answers, so only the rollback can restore the list
      return gets === 1 ? ok(["a"]) : new Promise<Response>(() => undefined);
    });
    const { result } = renderHook(() => useListAndCreate(), { wrapper: wrapper("A") });
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["a"]));
    act(() => void result.current.create.mutateAsync("b").catch(() => undefined));
    // the failed write was answered and the refetch started (and hangs): only the rollback can show ["a"]
    await waitFor(() => expect(gets).toBe(2));
    expect(result.current.list.data?.data).toEqual(["a"]);
  });

  it("invalidates the listed queries when the write settles", async () => {
    let n = 0;
    mockFetch(async (_u, init) => (init.method === "POST" ? ok({ id: "1" }) : ok([`v${++n}`])));
    const { result } = renderHook(
      () => ({
        list: useApiQuery<string[]>(["things"], "/things"),
        create: useCreate({ invalidate: [["things"]] }),
      }),
      { wrapper: wrapper("A") },
    );
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["v1"]));
    await act(async () => void (await result.current.create.mutateAsync("x")));
    await waitFor(() => expect(result.current.list.data?.data).toEqual(["v2"]));
  });
});
