import { render } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

describe("Skeleton", () => {
  it("shimmers instead of pulsing", () => {
    const { container } = render(<Skeleton className="h-4" />);
    const el = container.querySelector('[data-slot="skeleton"]');
    expect(el).toHaveClass("skeleton-shimmer");
    expect(el).not.toHaveClass("animate-pulse");
  });

  it("is the only loading placeholder: no source file uses animate-pulse", () => {
    const offenders = sources(join(process.cwd(), "src")).filter((f) =>
      readFileSync(f, "utf8").includes("animate-pulse"),
    );
    expect(offenders).toEqual([]);
  });
});
