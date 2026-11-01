import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "@/app/(marketing)/page";

describe("Home", () => {
  it("renders the OpsDesk heading", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1, name: "OpsDesk" })).toBeInTheDocument();
  });
});
