import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyRequestId } from "./copy-request-id";

describe("CopyRequestId", () => {
  afterEach(() => vi.useRealTimers());

  it("says Copied for 1.5 seconds, like the other copy button, then goes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CopyRequestId requestId="req_123" />);
    await user.click(screen.getByRole("button", { name: /Copy request ID/ }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1500);
    await waitFor(() => expect(screen.queryByText("Copied")).toBeNull());
  });
});
