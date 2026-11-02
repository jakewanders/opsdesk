import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClientApiError } from "@/lib/api-client/api-fetch";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import { DemoResetButton } from "./demo-reset-button";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refresh: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/lib/api-client/api-fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client/api-fetch")>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/components/shared/toast", () => ({ notify: { success: mocks.success } }));

beforeEach(() => {
  mocks.apiFetch.mockReset().mockResolvedValue({ data: {}, meta: {} });
  mocks.refresh.mockReset();
  mocks.success.mockReset();
});

const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Reset Demo" }));
  return user;
};

describe("DemoResetButton", () => {
  it("opens a confirmation that says exactly what happens, with a destructive 'Reset demo' button", async () => {
    render(<DemoResetButton />);
    await open();
    const dialog = await screen.findByRole("alertdialog", { name: "Reset the demo?" });
    expect(dialog).toHaveTextContent(
      "Your demo changes will be replaced with the original sample data.",
    );
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    expect(dialog).toHaveTextContent(/24-hour timer does not restart/i);
    expect(screen.getByRole("button", { name: "Reset demo" })).toBeEnabled();
    expect(mocks.apiFetch).not.toHaveBeenCalled(); // nothing happens until confirmed
  });

  it("Cancel closes it and sends nothing", async () => {
    render(<DemoResetButton />);
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it("confirming calls the endpoint with an idempotency key, clears the cache, toasts, refreshes the page data and closes", async () => {
    const grabbed: { client?: ReturnType<typeof useQueryClient> } = {};
    function Grab() {
      const qc = useQueryClient();
      useEffect(() => {
        grabbed.client = qc;
      });
      return null;
    }
    render(
      <ApiClientProvider organizationId="o1">
        <Grab />
        <DemoResetButton />
      </ApiClientProvider>,
    );
    grabbed.client!.setQueryData(["o1", "customers"], { data: [], meta: {} });
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.apiFetch).toHaveBeenCalledWith("/demo/reset", {
      method: "POST",
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{8,128}$/),
    });
    expect(grabbed.client!.getQueryCache().getAll()).toHaveLength(0);
    expect(mocks.success).toHaveBeenCalledWith("Demo reset", expect.any(String));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("a throttled reset keeps the dialog open and says how long to wait (no crash, no refresh, no success toast)", async () => {
    mocks.apiFetch.mockRejectedValue(
      new ClientApiError(
        429,
        "DEMO_RESET_THROTTLED",
        "You can reset the demo once a minute. Try again in 42 seconds.",
        "r",
        undefined,
        undefined,
        42,
      ),
    );
    render(<DemoResetButton />);
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Reset demo" }));
    expect(await screen.findByText(/Try again in 42 seconds/)).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("a retry after a failure reuses the idempotency key; after a success the next reset uses a new one", async () => {
    mocks.apiFetch
      .mockRejectedValueOnce(new ClientApiError(0, "NETWORK_ERROR", "offline"))
      .mockResolvedValue({ data: {}, meta: {} });
    render(<DemoResetButton />);
    const user = await open();
    await user.click(await screen.findByRole("button", { name: "Reset demo" }));
    await screen.findByText("offline");
    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    const [first, second] = mocks.apiFetch.mock.calls.map((c) => c[1].idempotencyKey);
    expect(second).toBe(first);
    await user.click(screen.getByRole("button", { name: "Reset Demo" }));
    await user.click(await screen.findByRole("button", { name: "Reset demo" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(mocks.apiFetch.mock.calls[2][1].idempotencyKey).not.toBe(first);
  });

  it("spamming the confirm button sends one request (it is disabled while pending)", async () => {
    let release!: () => void;
    mocks.apiFetch.mockImplementation(
      () => new Promise((r) => (release = () => r({ data: {}, meta: {} }))),
    );
    render(<DemoResetButton />);
    const user = await open();
    const confirm = await screen.findByRole("button", { name: "Reset demo" });
    await user.click(confirm);
    await user.click(confirm);
    await user.click(confirm);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("has no accessibility violations closed or open", async () => {
    const { container } = render(<DemoResetButton />);
    await expectNoA11yViolations(container);
    await open();
    await screen.findByRole("alertdialog");
    await expectNoA11yViolations(document.body);
  });
});
