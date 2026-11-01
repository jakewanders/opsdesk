import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { expectNoA11yViolations } from "@/test/axe";
import { AppShell } from "./app-shell";
import { NAV_ITEMS, getNavItems } from "./nav-config";

const pathname = vi.hoisted(() => ({ value: "/app" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value }));

const items = getNavItems(
  { quotes: true },
  NAV_ITEMS.map((i) => i.href),
);

function renderShell(props: Partial<React.ComponentProps<typeof AppShell>> = {}) {
  const view = render(
    <ThemeProvider>
      <AppShell items={items} {...props}>
        <h1>Page title</h1>
      </AppShell>
    </ThemeProvider>,
  );
  return { ...view, user: userEvent.setup() };
}

describe("AppShell", () => {
  beforeEach(() => {
    pathname.value = "/app";
  });

  it("has header, nav, and main landmarks", () => {
    renderShell();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Main" })).not.toHaveLength(0);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });

  it("makes the skip link the first focusable element and points it at main", async () => {
    const { user } = renderShell();
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#main-content");
    await user.tab();
    expect(skip).toHaveFocus();
  });

  it("marks the current section with aria-current=page", () => {
    pathname.value = "/app/customers/42";
    renderShell();
    const desktop = screen.getAllByRole("navigation", { name: "Main" })[0];
    expect(within(desktop).getByRole("link", { name: "Customers" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(desktop).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows Settings in the nav and omits Quotes when the flag is off", () => {
    const noQuotes = getNavItems(
      { quotes: false },
      NAV_ITEMS.map((i) => i.href),
    );
    renderShell({ items: noQuotes });
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0];
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Quotes" })).not.toBeInTheDocument();
  });

  it("renders the org selector slot, theme toggle, and user menu without any data", () => {
    renderShell();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Theme:/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
  });

  it("renders a custom org selector and the banner slot above the content", () => {
    renderShell({ orgSelector: "Acme Co", banner: <div role="status">Guest demo</div> });
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
    const banner = screen.getByRole("status");
    const main = screen.getByRole("main");
    expect(banner.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("opens the drawer from the keyboard, navigates, and returns focus to the trigger on Escape", async () => {
    const { user } = renderShell();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("closes the drawer after choosing a link", async () => {
    const { user } = renderShell();
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("link", { name: "Tasks" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("has no axe violations (closed and with the drawer open)", async () => {
    const { container, user } = renderShell();
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = await screen.findByRole("dialog");
    await expectNoA11yViolations(dialog);
  });
});
