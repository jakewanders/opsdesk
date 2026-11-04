import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { DemoCountdown } from "./demo-countdown";
import { DemoEndedPanel } from "./demo-ended-panel";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

describe("DemoCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const SERVER_NOW = "2026-11-01T12:00:00Z";

  it("shows the time left, from the server's clock and the database expiry", () => {
    render(<DemoCountdown expiresAt="2026-11-02T11:59:00Z" serverNow={SERVER_NOW} />);
    expect(screen.getByTestId("demo-remaining")).toHaveTextContent("23h 59m");
    expect(screen.getByRole("note")).toHaveTextContent(
      "Data is fictional and is deleted when the demo ends.",
    );
  });
  it("ignores the browser's clock entirely", () => {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z")); // a wrong device clock
    render(<DemoCountdown expiresAt="2026-11-01T13:00:00Z" serverNow={SERVER_NOW} />);
    expect(screen.getByTestId("demo-remaining")).toHaveTextContent("1h 00m");
  });
  it("counts down as the tab stays open", () => {
    render(<DemoCountdown expiresAt="2026-11-01T12:10:00Z" serverNow={SERVER_NOW} />);
    expect(screen.getByTestId("demo-remaining")).toHaveTextContent("10m 00s");
    act(() => void vi.advanceTimersByTime(125_000));
    expect(screen.getByTestId("demo-remaining")).toHaveTextContent("7m 55s");
  });
  it("announces only when a threshold is crossed, in a polite live region", () => {
    render(<DemoCountdown expiresAt="2026-11-01T12:20:00Z" serverNow={SERVER_NOW} />);
    const live = screen.getByRole("status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Less than an hour left in this demo.");
    act(() => void vi.advanceTimersByTime(5 * 60_000));
    expect(live).toHaveTextContent("Less than an hour left in this demo."); // unchanged: nothing re-announced
    act(() => void vi.advanceTimersByTime(6 * 60_000));
    expect(live).toHaveTextContent("Less than 10 minutes left in this demo.");
  });
  it("says the demo ended and refreshes the page at zero", () => {
    render(<DemoCountdown expiresAt="2026-11-01T12:00:10Z" serverNow={SERVER_NOW} />);
    expect(refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(15_000));
    expect(screen.getByRole("note")).toHaveTextContent("This demo has ended.");
    expect(refresh).toHaveBeenCalled();
  });
  it("has no axe violations", async () => {
    vi.useRealTimers();
    const { container } = render(
      <DemoCountdown expiresAt="2026-11-02T11:59:00Z" serverNow={SERVER_NOW} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("DemoEndedPanel", () => {
  it("says the demo ended and offers one way forward", () => {
    render(<DemoEndedPanel action={async () => ({})} />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Your demo has ended" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new demo" })).toBeEnabled();
    expect(screen.getByText(/24 hours/)).toBeInTheDocument();
  });
  it("runs the restart action once and locks the button while it works", async () => {
    const user = userEvent.setup();
    let release: (v: { error?: string }) => void = () => undefined;
    const action = vi.fn(() => new Promise<{ error?: string }>((resolve) => (release = resolve)));
    render(<DemoEndedPanel action={action} />);
    await user.dblClick(screen.getByRole("button", { name: "Start a new demo" }));
    const busy = await screen.findByRole("button", { name: "Start a new demo" });
    await waitFor(() => expect(busy).toBeDisabled());
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(action).toHaveBeenCalledTimes(1);
    release({ error: "The demo is very busy right now. Please try again in a few minutes." });
    expect(await screen.findByRole("alert")).toHaveTextContent("very busy");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start a new demo" })).toBeEnabled(),
    );
  });
  it("is keyboard operable and has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = render(<DemoEndedPanel action={async () => ({ error: "x" })} />);
    await expectNoA11yViolations(container);
    await user.tab();
    expect(screen.getByRole("button", { name: "Start a new demo" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    await expectNoA11yViolations(container);
  });
});
