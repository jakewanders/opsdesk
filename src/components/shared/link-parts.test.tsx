import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberList } from "@/lib/api-client/list-memory";
import { expectNoA11yViolations } from "@/test/axe";
import { ArchivedBadge } from "./archived-badge";
import { Breadcrumbs } from "./breadcrumbs";
import { CopyLinkButton } from "./copy-link-button";
import { ListLink } from "./list-crumb";
import { ScopeNote } from "./scope-note";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("./toast", () => ({ notify }));

beforeEach(() => {
  window.sessionStorage.clear();
  notify.error.mockClear();
  notify.success.mockClear();
});

describe("Breadcrumbs", () => {
  it("links every crumb but the last, which is the current page", async () => {
    const { container } = render(
      <Breadcrumbs
        items={[{ label: "Customers", href: "/app/customers" }, { label: "Acme Plumbing" }]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Customers" })).toHaveAttribute(
      "href",
      "/app/customers",
    );
    expect(within(nav).queryByRole("link", { name: "Acme Plumbing" })).not.toBeInTheDocument();
    expect(within(nav).getByText("Acme Plumbing")).toHaveAttribute("aria-current", "page");
    await expectNoA11yViolations(container);
  });
});

describe("ListLink keeps the filters the list had", () => {
  it("points at the remembered URL, and at the plain list when none was remembered", async () => {
    const { unmount } = render(<ListLink list="customers">Customers</ListLink>);
    expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute(
      "href",
      "/app/customers",
    );
    unmount();
    rememberList("customers", "/app/customers?q=acme&status=lead&page=2");
    render(<ListLink list="customers">Customers</ListLink>);
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute(
        "href",
        "/app/customers?q=acme&status=lead&page=2",
      ),
    );
  });
});

describe("CopyLinkButton", () => {
  afterEach(() => vi.useRealTimers());
  it("swaps its icon for a check for a moment after copying", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CopyLinkButton />);
    expect(screen.queryByTestId("copied-icon")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByTestId("copied-icon")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(1500);
    await waitFor(() => expect(screen.queryByTestId("copied-icon")).toBeNull());
  });
  it("a second copy restarts the confirmation instead of cutting it short", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CopyLinkButton />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await screen.findByTestId("copied-icon");
    await vi.advanceTimersByTimeAsync(1000);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByTestId("copied-icon")).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(600);
    await waitFor(() => expect(screen.queryByTestId("copied-icon")).toBeNull());
  });
  it("copies the address of the view as it is now and says so", async () => {
    const user = userEvent.setup(); // installs its own clipboard, which is then watched
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<CopyLinkButton />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(window.location.href);
    expect(notify.success).toHaveBeenCalledWith(
      "Link copied",
      expect.stringContaining("this workspace"),
    );
  });
  it("says what to do when the clipboard is not available", async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    render(<CopyLinkButton />);
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(notify.error).toHaveBeenCalledWith(
      "The link could not be copied",
      expect.stringContaining("address bar"),
    );
  });
});

describe("ScopeNote and ArchivedBadge", () => {
  it("names the narrowing in words and offers a way out", async () => {
    const onClear = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <ScopeNote text="Showing only tasks linked to one customer." onClear={onClear} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing only tasks linked to one customer.",
    );
    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(onClear).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });
  it("the badge says Archived in words", () => {
    render(<ArchivedBadge />);
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });
});
