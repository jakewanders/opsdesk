import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PageTransition } from "./page-transition";

describe("PageTransition", () => {
  it("renders its children once, and without view-transition support in the browser", () => {
    expect("startViewTransition" in document).toBe(false); // jsdom has none: pages must still render
    render(
      <PageTransition>
        <h1>Customers</h1>
      </PageTransition>,
    );
    expect(screen.getAllByRole("heading", { name: "Customers" })).toHaveLength(1);
  });
});

describe("view transition styles", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("defines the crossfade and both directions", () => {
    for (const name of ["page-fade", "nav-forward", "nav-back"]) {
      expect(css).toContain(`::view-transition-old(.${name})`);
      expect(css).toContain(`::view-transition-new(.${name})`);
    }
  });

  it("lets clicks through while a transition runs", () => {
    expect(css).toMatch(/::view-transition\s*\{\s*pointer-events:\s*none;/);
  });

  it("removes every view transition animation under reduced motion", () => {
    expect(css).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{\s*::view-transition-old\(\*\),[\s\S]*?animation-duration:\s*0s !important/,
    );
  });
});
