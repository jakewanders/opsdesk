import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button pending", () => {
  it("is disabled, busy and ignores clicks while pending", async () => {
    const onClick = vi.fn();
    render(
      <Button pending onClick={onClick}>
        Save changes
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save changes" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps its label in the DOM so the width and accessible name hold", () => {
    render(<Button pending>Save changes</Button>);
    expect(screen.getByText("Save changes")).toBeInTheDocument();
  });

  it("is not busy when idle", () => {
    render(<Button>Save changes</Button>);
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy");
  });
});
