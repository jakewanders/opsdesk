import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { ConfirmDialog } from "./confirm-dialog";
import { EmptyState } from "./empty-state";
import { ErrorAlert } from "./error-alert";
import { ChartSkeleton, CardSkeleton, TableSkeleton } from "./skeletons";
import { ToastProvider, notify } from "./toast";

const THEMES = ["light", "dark"] as const;

function setTheme(theme: (typeof THEMES)[number]) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
});

describe("skeletons", () => {
  it("announce one polite status per area, not one per block", () => {
    render(<TableSkeleton rows={6} columns={4} label="Loading customers" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(within(status).getByText("Loading customers")).toHaveClass("sr-only");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("renders the requested table shape", () => {
    const { container } = render(<TableSkeleton rows={3} columns={2} />);
    // header row + 3 body rows, 2 cells each
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(2 + 3 * 2);
  });

  it("hides the decorative blocks from assistive technology", () => {
    const { container } = render(<CardSkeleton count={3} />);
    const decorative = container.querySelector('[aria-hidden="true"]');
    expect(decorative).not.toBeNull();
    expect(decorative?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(9);
  });

  it.each(THEMES)("have no axe violations in the %s theme", async (theme) => {
    setTheme(theme);
    const { container } = render(
      <>
        <TableSkeleton label="Loading table" />
        <CardSkeleton count={4} label="Loading metrics" />
        <ChartSkeleton />
      </>,
    );
    await expectNoA11yViolations(container);
  });
});

describe("EmptyState", () => {
  it("shows title, explanation, and the call to action", () => {
    render(
      <EmptyState
        title="No customers yet"
        description="Add your first customer to start tracking opportunities."
        action={<button type="button">Add customer</button>}
        icon={<svg data-testid="icon" />}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "No customers yet" })).toBeInTheDocument();
    expect(screen.getByText(/Add your first customer/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add customer" })).toBeInTheDocument();
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("supports a nested heading level and no action", () => {
    render(<EmptyState title="No tasks" description="Nothing due." headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(THEMES)("has no axe violations in the %s theme", async (theme) => {
    setTheme(theme);
    const { container } = render(
      <EmptyState
        title="No tasks"
        description="Nothing due."
        action={<a href="/app/tasks/new">Add task</a>}
      />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("ErrorAlert", () => {
  it("is an alert, so screen readers announce it when it appears", () => {
    render(<ErrorAlert message="The customer could not be saved. Check the highlighted fields." />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).toHaveTextContent("The customer could not be saved");
  });

  it("renders the request ID from the prop", () => {
    render(<ErrorAlert message="Failed." requestId="req_8f31a" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Request ID: req_8f31a");
  });

  it("renders the message and request ID from an API error envelope body", () => {
    render(
      <ErrorAlert
        error={{ code: "conflict", message: "Someone else edited this.", requestId: "req_42" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Someone else edited this.");
    expect(alert).toHaveTextContent("req_42");
  });

  it("omits the request ID line when there is none", () => {
    render(<ErrorAlert message="Failed." />);
    expect(screen.getByRole("alert")).not.toHaveTextContent("Request ID");
  });

  it("has no copy button when there is no request ID", () => {
    render(<ErrorAlert message="Failed." />);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("copies the request ID to the clipboard and says so; says so too when the clipboard refuses", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    render(<ErrorAlert message="Failed." requestId="req_8f31a" />);
    await user.click(screen.getByRole("button", { name: "Copy request ID req_8f31a" }));
    expect(writeText).toHaveBeenCalledWith("req_8f31a");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Request ID copied"));
    expect(screen.getByRole("button", { name: /Copy request ID/ })).toHaveTextContent("Copied");

    writeText.mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: /Copy request ID/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not copy"));
    await expectNoA11yViolations(document.body);
  });

  it("offers a retry that calls back", async () => {
    const onRetry = vi.fn();
    render(<ErrorAlert message="Failed." onRetry={onRetry} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it.each(THEMES)("has no axe violations in the %s theme", async (theme) => {
    setTheme(theme);
    const { container } = render(
      <ErrorAlert message="Failed." requestId="req_1" onRetry={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});

describe("toasts", () => {
  it("announce through a polite live region without moving focus", async () => {
    render(
      <>
        <button type="button">Save changes</button>
        <ToastProvider />
      </>,
    );
    const button = screen.getByRole("button", { name: "Save changes" });
    button.focus();

    act(() => {
      notify.success("Changes saved");
    });

    const toast = await screen.findByText("Changes saved");
    const region = toast.closest("[aria-live]");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(button).toHaveFocus();
  });
});

function Harness({
  onConfirm,
  onClosed,
}: {
  onConfirm: () => void | Promise<void>;
  onClosed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Archive
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onClosed?.();
        }}
        title="Archive Acme Co?"
        description="Archived customers leave the active list. You can restore them later."
        confirmLabel="Archive customer"
        onConfirm={onConfirm}
      />
    </>
  );
}

describe("ConfirmDialog", () => {
  it("opens with focus on Cancel and names the action with a verb", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Archive Acme Co?" });
    expect(within(dialog).getByRole("button", { name: "Archive customer" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("traps focus: Tab and Shift+Tab never leave the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on Esc and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    const trigger = screen.getByRole("button", { name: "Archive" });
    await user.click(trigger);
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes with Cancel without confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("is fully keyboard operable: Tab to the confirm button and press Enter", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await screen.findByRole("alertdialog");
    await user.tab(); // Cancel -> Archive customer
    expect(screen.getByRole("button", { name: "Archive customer" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("treats a running action as critical: Esc is ignored and buttons are disabled", async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<Harness onConfirm={onConfirm} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(await screen.findByRole("button", { name: "Archive customer" }));

    expect(screen.getByRole("button", { name: "Archive customer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("stays open and announces the failure when the action throws", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        onConfirm={() => {
          throw new Error("The customer is linked to an open quote.");
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive" }));
    await user.click(await screen.findByRole("button", { name: "Archive customer" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The customer is linked to an open quote.");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive customer" })).toBeEnabled();
  });

  it.each(THEMES)("has no axe violations in the %s theme", async (theme) => {
    setTheme(theme);
    const user = userEvent.setup();
    render(<Harness onConfirm={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    await expectNoA11yViolations(dialog);
  });
});
