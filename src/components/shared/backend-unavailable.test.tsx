import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { BackendUnavailable } from "./backend-unavailable";

describe("BackendUnavailable", () => {
  it("says what happened, that nothing was created, and offers retry plus the static pages", () => {
    render(
      <BackendUnavailable action="open the demo" repoUrl="https://github.com/example/opsdesk" />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "The live backend is not answering" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/could not open the demo because the database is paused or unreachable/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/nothing was created/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Read the technical overview" })).toHaveAttribute(
      "href",
      "/#technical-overview",
    );
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/example/opsdesk",
    );
  });
  it("omits the repository link when none is configured, and never claims success", () => {
    render(<BackendUnavailable />);
    expect(screen.queryByRole("link", { name: /GitHub/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/welcome|success|ready/i);
  });
  it("Try again reloads the page", async () => {
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, reload },
    });
    render(<BackendUnavailable />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, "location", { configurable: true, value: original });
  });
  it("has no accessibility violations", async () => {
    const { container } = render(
      <BackendUnavailable repoUrl="https://github.com/example/opsdesk" />,
    );
    await expectNoA11yViolations(container);
  });
});
