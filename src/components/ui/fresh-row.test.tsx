import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFreshForTests, markFresh } from "@/lib/motion/fresh";
import { FreshRow } from "./table";

const renderRow = () =>
  render(
    <table>
      <tbody>
        <FreshRow entityId="c1">
          <td>Acme</td>
        </FreshRow>
      </tbody>
    </table>,
  );

describe("FreshRow", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearFreshForTests();
    vi.useRealTimers();
  });

  it("flashes right after its entity was marked fresh, then settles back", () => {
    renderRow();
    const row = screen.getByRole("row");
    expect(row).toHaveAttribute("data-fresh", "false");
    act(() => markFresh("c1"));
    expect(row).toHaveAttribute("data-fresh", "true");
    expect(row).toHaveClass("animate-flash");
    act(() => void vi.advanceTimersByTime(1600));
    expect(row).toHaveAttribute("data-fresh", "false");
    expect(row).not.toHaveClass("animate-flash");
  });

  it("ignores other entities", () => {
    renderRow();
    act(() => markFresh("someone-else"));
    expect(screen.getByRole("row")).toHaveAttribute("data-fresh", "false");
  });
});
