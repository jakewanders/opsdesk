import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UserMenu } from "@/components/layout/user-menu";
import type { WorkspaceSummary } from "@/lib/api/organizations";
import type { WorkspaceFormState } from "@/lib/org/form-state";
import { expectNoA11yViolations } from "@/test/axe";
import { OrgSelector } from "./org-selector";
import { WorkspaceSetupForm } from "./workspace-setup-form";

vi.mock("@/lib/auth/actions", () => ({ logoutAction: vi.fn() }));

type Action = (s: WorkspaceFormState, f: FormData) => Promise<WorkspaceFormState>;
const failure = (extra: Partial<WorkspaceFormState>): Action =>
  vi.fn(async (prev) => ({ status: "error" as const, attempt: prev.attempt + 1, ...extra }));

describe("WorkspaceSetupForm", () => {
  it("shows name, industry, a searchable time zone and the fixed currency", () => {
    const { container } = render(<WorkspaceSetupForm action={failure({})} />);
    expect(screen.getByRole("textbox", { name: /Workspace name/ })).toBeRequired();
    expect(screen.getByRole("textbox", { name: /Industry/ })).not.toBeRequired();
    const tz = screen.getByRole("combobox", { name: /Time zone/ });
    expect(tz).toHaveAttribute("list");
    expect(container.querySelector("datalist")?.querySelectorAll("option").length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/US dollars \(USD\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeEnabled();
  });
  it("defaults the time zone to the browser's", () => {
    const original = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      () =>
        ({
          resolvedOptions: () => ({ timeZone: "Europe/Berlin" }),
        }) as unknown as Intl.DateTimeFormat,
    );
    render(<WorkspaceSetupForm action={failure({})} />);
    expect(screen.getByRole("combobox", { name: /Time zone/ })).toHaveValue("Europe/Berlin");
    vi.restoreAllMocks();
    expect(Intl.DateTimeFormat).toBe(original);
  });
  it("lets the user type to search and choose another zone", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSetupForm action={failure({})} />);
    const tz = screen.getByRole("combobox", { name: /Time zone/ });
    await user.clear(tz);
    await user.type(tz, "America/Denver");
    expect(tz).toHaveValue("America/Denver");
  });
  it("shows field errors from the API schema, focuses the summary, and links to the field", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSetupForm
        action={failure({
          fieldErrors: {
            name: ["Use between 2 and 80 characters."],
            timezone: ["Choose a valid time zone, for example America/New_York."],
          },
          values: { name: "A", industry: "", timezone: "Mars/Base" },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole("textbox", { name: /Workspace name/ })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await user.click(screen.getByRole("link", { name: "Use between 2 and 80 characters." }));
    expect(screen.getByRole("textbox", { name: /Workspace name/ })).toHaveFocus();
    expect(screen.getByRole("combobox", { name: /Time zone/ })).toHaveValue("Mars/Base");
  });
  it("tells a guest to create an account instead of showing the form (the 403 case)", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSetupForm action={failure({ guest: true, message: "x" })} />);
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(
      await screen.findByRole("heading", { name: "Create an account to keep your data" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup",
    );
    expect(screen.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
  });
  it("locks the button while creating", async () => {
    const user = userEvent.setup();
    let release: (s: WorkspaceFormState) => void = () => undefined;
    const action = vi.fn(() => new Promise<WorkspaceFormState>((r) => (release = r)));
    render(<WorkspaceSetupForm action={action} />);
    await user.type(screen.getByRole("textbox", { name: /Workspace name/ }), "Acme");
    await user.dblClick(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1);
    release({ status: "error", attempt: 1, message: "x" });
  });
  it("is keyboard operable and passes axe, idle and with errors", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkspaceSetupForm action={failure({ fieldErrors: { name: ["Enter a value."] } })} />,
    );
    await expectNoA11yViolations(container);
    await user.tab();
    expect(screen.getByRole("textbox", { name: /Workspace name/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: /Industry/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("combobox", { name: /Time zone/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Create workspace" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("alert");
    await expectNoA11yViolations(container);
  });
});

const ws = (id: string, name: string, over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  name,
  kind: "real",
  role: "owner",
  timezone: "UTC",
  expiresAt: null,
  secondsRemaining: null,
  expired: false,
  ...over,
});

describe("OrgSelector", () => {
  const select = vi.fn(async () => undefined);
  it("lists the user's workspaces, marks the active one and offers to create another", async () => {
    const user = userEvent.setup();
    render(
      <OrgSelector
        workspaces={[ws("a", "Acme"), ws("b", "Beta")]}
        activeId="b"
        selectAction={select}
        canCreate
      />,
    );
    const trigger = screen.getByRole("button", { name: /Workspace: Beta/ });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Acme" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Beta" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(menu).getByRole("menuitem", { name: /Create workspace/ })).toHaveAttribute(
      "href",
      "/app/setup",
    );
  });
  it("submits the chosen workspace id to the server action (never authorization)", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (data: FormData) => void data);
    render(
      <OrgSelector
        workspaces={[ws("a", "Acme"), ws("b", "Beta")]}
        activeId="a"
        selectAction={action}
        canCreate
      />,
    );
    await user.click(screen.getByRole("button", { name: /Change workspace/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect((action.mock.calls[0][0] as FormData).get("orgId")).toBe("b");
  });
  it("is keyboard operable: arrows, Enter and Escape", async () => {
    const user = userEvent.setup();
    render(
      <OrgSelector
        workspaces={[ws("a", "Acme"), ws("b", "Beta")]}
        activeId="a"
        selectAction={select}
        canCreate
      />,
    );
    screen.getByRole("button", { name: /Change workspace/ }).focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Change workspace/ })).toHaveFocus();
  });
  it("asks the user to choose when none is selected", () => {
    render(
      <OrgSelector
        workspaces={[ws("a", "Acme"), ws("b", "Beta")]}
        activeId={null}
        selectAction={select}
        canCreate
      />,
    );
    expect(screen.getByRole("button", { name: /none selected/ })).toHaveTextContent(
      "Choose a workspace",
    );
  });
  it("shows a guest's single demo as plain text, with no way to create a workspace", () => {
    render(
      <OrgSelector
        workspaces={[ws("d", "Demo Workspace", { kind: "demo" })]}
        activeId="d"
        selectAction={select}
        canCreate={false}
      />,
    );
    expect(screen.getByText("Demo Workspace")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("passes axe closed and open", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <OrgSelector
        workspaces={[ws("a", "Acme"), ws("b", "Beta")]}
        activeId="a"
        selectAction={select}
        canCreate
      />,
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: /Change workspace/ }));
    await screen.findByRole("menu");
    await expectNoA11yViolations(document.body);
  });
});

describe("UserMenu", () => {
  it("shows a member's name, account state and email, with sign out", async () => {
    const user = userEvent.setup();
    render(<UserMenu user={{ name: "Ada Lovelace", email: "ada@example.com", isGuest: false }} />);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(menu).getByText("Member: ada@example.com")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });
  it("shows a guest as a guest, without an email", async () => {
    const user = userEvent.setup();
    render(<UserMenu user={{ name: "Demo Owner", email: null, isGuest: true }} />);
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Demo Owner")).toBeInTheDocument();
    expect(within(menu).getByText("Guest: exploring a demo")).toBeInTheDocument();
    expect(menu).not.toHaveTextContent("@");
  });
});
