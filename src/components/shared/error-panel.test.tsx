import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { ErrorPanel } from "./error-panel";

afterEach(() => vi.restoreAllMocks());

describe("ErrorPanel", () => {
  it("shows the server reference when there is one, and retries", async () => {
    const reset = vi.fn();
    const error = Object.assign(new Error("x"), { digest: "d-123" });
    const { container } = render(<ErrorPanel error={error} reset={reset} />);
    expect(screen.getByText("Reference: d-123")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("shows the error's own name and message when a browser-side error has no digest", () => {
    render(<ErrorPanel error={new TypeError("x is not a function")} reset={() => undefined} />);
    expect(screen.getByText("Details: TypeError: x is not a function")).toBeInTheDocument();
  });

  it("says the page is out of date after a deploy, with a reload button, never a crash with no reference", async () => {
    const error = new Error('Server Action "6005" was not found on the server.');
    error.name = "UnrecognizedActionError";
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    const { container } = render(<ErrorPanel error={error} reset={() => undefined} />);
    expect(screen.getByRole("heading", { name: "This page is out of date" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing was saved/)).toBeInTheDocument();
    expect(screen.queryByText(/Reference:/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reload page" }));
    expect(reload).toHaveBeenCalled();
    await expectNoA11yViolations(container);
    vi.unstubAllGlobals();
  });
});
