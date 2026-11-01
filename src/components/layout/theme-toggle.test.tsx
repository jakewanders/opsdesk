import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, THEME_STORAGE_KEY } from "@/components/layout/theme-provider";
import { ThemeToggle } from "@/components/layout/theme-toggle";

function setup() {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
  return userEvent.setup();
}

describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.className = "";
  });

  it("defaults to the light theme", () => {
    setup();
    expect(screen.getByRole("button", { name: /Theme: Light/ })).toBeInTheDocument();
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("cycles light, dark, system and persists the choice", async () => {
    const user = setup();
    await user.click(screen.getByRole("button", { name: /Theme: Light/ }));
    expect(screen.getByRole("button", { name: /Theme: Dark/ })).toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: /Theme: Dark/ }));
    expect(screen.getByRole("button", { name: /Theme: System/ })).toBeInTheDocument();
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    await user.click(screen.getByRole("button", { name: /Theme: System/ }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("restores a stored dark choice on mount", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    setup();
    expect(screen.getByRole("button", { name: /Theme: Dark/ })).toBeInTheDocument();
    expect(document.documentElement).toHaveClass("dark");
  });
});
