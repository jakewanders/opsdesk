import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

const TOKENS: Record<string, string> = {
  "motion-fast": "120ms",
  "motion-base": "180ms",
  "motion-slow": "280ms",
  "ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
  "ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
  "ease-settle": "cubic-bezier(0.34, 1.4, 0.64, 1)",
};

describe("motion tokens", () => {
  it.each(Object.entries(TOKENS))("declares --%s as %s", (name, value) => {
    const re = new RegExp(`--${name}:\\s*${value.replace(/[().,]/g, "\\$&")};`);
    expect(css).toMatch(re);
  });
});

const UI = ["input", "dialog", "sheet", "drawer", "dropdown-menu", "select", "alert-dialog"];

describe("ui primitives use the motion tokens", () => {
  it.each(UI)("%s.tsx", (name) => {
    const src = readFileSync(join(process.cwd(), `src/components/ui/${name}.tsx`), "utf8");
    expect(src).toContain("--motion-");
    expect(src).not.toMatch(/duration-(100|150|200|300)\b/);
  });
});

describe("motion rules in globals.css", () => {
  const rule = (selector: string) => {
    const start = css.indexOf(selector);
    return css.slice(start, css.indexOf("}", start));
  };

  it("flashes a changed row once, within the 280ms ceiling", () => {
    expect(rule(".animate-flash {")).toMatch(
      /animation:\s*flash var\(--motion-slow\) var\(--ease-out\);/,
    );
  });

  it("keeps page transitions within the 280ms ceiling: the arriving page waits for the leaving one", () => {
    for (const name of ["page-fade", "nav-forward", "nav-back"]) {
      const block = rule(`::view-transition-new(.${name})`);
      expect(block).toContain("calc(var(--motion-slow) - var(--motion-fast))");
    }
  });

  it.each(["dialog", "sheet", "alert-dialog", "dropdown-menu", "select"])(
    "%s closes faster than it opens",
    (name) => {
      const src = readFileSync(join(process.cwd(), `src/components/ui/${name}.tsx`), "utf8");
      expect(src).toContain("data-closed:duration-(--motion-fast)");
    },
  );
});
