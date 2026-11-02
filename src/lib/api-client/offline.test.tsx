import { onlineManager, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./api-fetch";
import { makeQueryClient } from "./query-client";

/** [SIT-262] With no network a request fails with the client's own message instead of waiting forever. */
function Probe() {
  const read = useQuery({ queryKey: ["x"], queryFn: () => apiFetch("/customers"), retry: false });
  const save = useMutation({
    mutationFn: () => apiFetch("/customers", { method: "POST", json: {} }),
  });
  return (
    <div>
      <p data-testid="read">{read.isError ? read.error.message : read.fetchStatus}</p>
      <button onClick={() => save.mutate()}>save</button>
      <p data-testid="write">
        {save.isError ? save.error.message : save.isPaused ? "paused" : save.status}
      </p>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe("offline behaviour", () => {
  it("a read and a write both fail with 'We could not reach the server' while the browser says it is offline", async () => {
    onlineManager.setOnline(false); // what TanStack Query sees when the browser reports "offline"
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    render(
      <QueryClientProvider client={makeQueryClient()}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("read")).toHaveTextContent("We could not reach the server"),
    );
    await userEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() =>
      expect(screen.getByTestId("write")).toHaveTextContent("We could not reach the server"),
    );
    expect(screen.getByTestId("write")).not.toHaveTextContent("paused");
  });
  it("the shared client is configured to send requests whatever the browser says", () => {
    const defaults = makeQueryClient().getDefaultOptions();
    expect(defaults.queries?.networkMode).toBe("always");
    expect(defaults.mutations?.networkMode).toBe("always");
  });
});
