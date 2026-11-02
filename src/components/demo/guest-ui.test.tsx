import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { DemoCountdown } from "./demo-countdown";
import { FictionalDataNote } from "./fictional-data-note";
import { GuestSettingsNotice } from "./guest-settings-notice";
import { GUEST_LIMITS } from "./guest-limits";
import { GuestModeProvider, GuestRestricted, RestrictedAction } from "./restricted-action";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const NOW = "2026-11-01T12:00:00Z";

describe("guest banner states", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("active: says what this is, how long is left, and offers Reset Demo and Create an account", () => {
    render(
      <DemoCountdown
        expiresAt="2026-11-02T11:00:00Z"
        serverNow={NOW}
        actions={<button type="button">Reset Demo</button>}
      />,
    );
    const banner = screen.getByRole("note", { name: "Demo workspace" });
    expect(banner).toHaveAttribute("data-state", "active");
    expect(banner).toHaveTextContent("Demo workspace • fictional data • resets automatically");
    expect(screen.getByTestId("demo-remaining")).toHaveTextContent("23h 00m");
    expect(screen.getByRole("button", { name: "Reset Demo" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup",
    );
    expect(banner).toHaveTextContent(/demo data is not carried over/i);
  });

  it("near expiry (under 10 minutes): says so in words, not only in colour", () => {
    render(<DemoCountdown expiresAt="2026-11-01T12:08:00Z" serverNow={NOW} />);
    const banner = screen.getByRole("note", { name: "Demo workspace" });
    expect(banner).toHaveAttribute("data-state", "near-end");
    expect(banner).toHaveTextContent("Less than 10 minutes left: about 8m 00s left.");
  });

  it("expired: says the demo ended and still offers Create an account", () => {
    render(<DemoCountdown expiresAt="2026-11-01T11:59:00Z" serverNow={NOW} />);
    const banner = screen.getByRole("note", { name: "Demo workspace" });
    expect(banner).toHaveAttribute("data-state", "ended");
    expect(banner).toHaveTextContent("This demo has ended.");
    expect(screen.queryByTestId("demo-remaining")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toBeInTheDocument();
  });

  it("the next state arrives as time passes (active to near expiry)", () => {
    render(<DemoCountdown expiresAt="2026-11-01T12:12:00Z" serverNow={NOW} />);
    expect(screen.getByRole("note", { name: "Demo workspace" })).toHaveAttribute(
      "data-state",
      "active",
    );
    act(() => void vi.advanceTimersByTime(125_000));
    expect(screen.getByRole("note", { name: "Demo workspace" })).toHaveAttribute(
      "data-state",
      "near-end",
    );
  });
});

describe("guest banner accessibility (real timers: axe needs them)", () => {
  it("has no axe violations in any state", async () => {
    for (const expiresAt of [
      "2026-11-02T11:00:00Z",
      "2026-11-01T12:08:00Z",
      "2026-11-01T11:59:00Z",
    ]) {
      const { container, unmount } = render(
        <DemoCountdown
          expiresAt={expiresAt}
          serverNow={NOW}
          actions={<button type="button">Reset Demo</button>}
        />,
      );
      await expectNoA11yViolations(container);
      unmount();
    }
  });
});

describe("RestrictedAction", () => {
  it("stays in the page, focusable, marked unavailable, and explained in visible text linked by aria-describedby", async () => {
    render(
      <RestrictedAction label="Invite member" reason="The demo is a single-person workspace." />,
    );
    const button = screen.getByRole("button", { name: "Invite member" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled(); // a real disabled attribute would drop it from the tab order
    expect(button).toHaveAccessibleDescription("The demo is a single-person workspace.");
    expect(screen.getByText("The demo is a single-person workspace.")).toBeVisible();
    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus(); // keyboard users reach it and hear the reason
  });

  it("does nothing when activated by mouse or keyboard", async () => {
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={submit}>
        <RestrictedAction label="Upload file" reason="Uploads are off in the demo." />
      </form>,
    );
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Upload file" });
    await user.click(button);
    button.focus();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(submit).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <RestrictedAction label="Billing" reason="No billing in the demo." />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("GuestRestricted", () => {
  const control = <button type="button">Invite member</button>;
  it("shows the real control to a member", () => {
    render(
      <GuestModeProvider isGuest={false}>
        <GuestRestricted label="Invite member" reason="Needs an account.">
          {control}
        </GuestRestricted>
      </GuestModeProvider>,
    );
    expect(screen.getByRole("button", { name: "Invite member" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.queryByText("Needs an account.")).not.toBeInTheDocument();
  });
  it("shows the explained, inert version to a guest instead of the real control", () => {
    const real = vi.fn();
    render(
      <GuestModeProvider isGuest>
        <GuestRestricted label="Invite member" reason="Needs an account.">
          <button type="button" onClick={real}>
            Invite member
          </button>
        </GuestRestricted>
      </GuestModeProvider>,
    );
    expect(screen.getByRole("button", { name: "Invite member" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Needs an account.")).toBeVisible();
  });
  it("outside any provider it behaves as a member (the server and database still decide)", () => {
    render(
      <GuestRestricted label="x" reason="y">
        {control}
      </GuestRestricted>,
    );
    expect(screen.getByRole("button", { name: "Invite member" })).toBeEnabled();
  });
});

describe("guest settings notice and fictional-data label", () => {
  it("says settings are read-only, lists every restricted feature with its reason, and links to sign up", async () => {
    const { container } = render(<GuestSettingsNotice />);
    expect(
      screen.getByRole("heading", { name: "Settings are read-only in the demo" }),
    ).toBeInTheDocument();
    for (const { feature, reason } of GUEST_LIMITS) {
      expect(screen.getByText(`${feature}.`)).toBeInTheDocument();
      expect(screen.getByText(reason)).toBeInTheDocument();
    }
    expect(GUEST_LIMITS.map((l) => l.feature)).toEqual([
      "Invite members",
      "Billing",
      "Integrations",
      "Send external email",
      "Upload files",
      "Create a real workspace",
    ]);
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup",
    );
    await expectNoA11yViolations(container);
  });
  it("labels the sample data as fictional", async () => {
    const { container } = render(<FictionalDataNote />);
    expect(screen.getByRole("note")).toHaveTextContent(/fictional demonstration data/i);
    await expectNoA11yViolations(container);
  });
});
