// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("jsx-a11y lint rules fail the build (error level)", () => {
  const eslint = new ESLint({ cwd: process.cwd() });

  async function rulesFor(code: string): Promise<Map<string, number>> {
    const [result] = await eslint.lintText(code, { filePath: "src/lib/a11y-fixture.tsx" });
    return new Map(result.messages.map((m) => [m.ruleId ?? "parse", m.severity]));
  }

  const cases: [string, string, string][] = [
    ["image without alt text", 'export const A = () => <img src="/x.png" />;', "jsx-a11y/alt-text"],
    [
      "click handler on a div",
      "export const A = () => <div onClick={() => {}}>x</div>;",
      "jsx-a11y/click-events-have-key-events",
    ],
    [
      "label not tied to a control",
      "export const A = () => <label>Name</label>;",
      "jsx-a11y/label-has-associated-control",
    ],
    [
      "anchor without a real href",
      'export const A = () => <a href="#">Go</a>;',
      "jsx-a11y/anchor-is-valid",
    ],
    [
      "invalid ARIA role",
      'export const A = () => <div role="banana">x</div>;',
      "jsx-a11y/aria-role",
    ],
    [
      "autofocus",
      'export const A = () => <input autoFocus aria-label="x" />;',
      "jsx-a11y/no-autofocus",
    ],
  ];

  it.each(cases)("%s", async (_name, code, rule) => {
    const rules = await rulesFor(code);
    expect(rules.get(rule), `${rule} should be an error`).toBe(2);
  });

  it("accepts accessible markup", async () => {
    const rules = await rulesFor(
      'export const A = () => <label htmlFor="n">Name<input id="n" /></label>;',
    );
    expect([...rules.keys()].filter((r) => r.startsWith("jsx-a11y/"))).toEqual([]);
  });
});

describe("reduced motion", () => {
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));

  it("has a global prefers-reduced-motion: reduce rule", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("applies to every element and pseudo-element", () => {
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
  });

  it.each([
    ["animation-duration", /animation-duration:\s*0\.01ms\s*!important/],
    ["animation-iteration-count", /animation-iteration-count:\s*1\s*!important/],
    ["transition-duration", /transition-duration:\s*0\.01ms\s*!important/],
    ["scroll-behavior", /scroll-behavior:\s*auto\s*!important/],
  ])("sets %s", (_name, pattern) => {
    expect(block).toMatch(pattern);
  });

  it("is not scoped to a class that components could skip", () => {
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).not.toMatch(/\.[a-z-]+\s*[,{]/i);
  });
});

describe("keyboard focus is visible", () => {
  it("has a global :focus-visible outline using the ring token", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
  });

  const UI = join(process.cwd(), "src/components/ui");
  // Interactive primitives that draw their own ring (Tailwind's outline-none removes the
  // global outline, so each must supply focus-visible styles).
  const INTERACTIVE = ["button", "input", "select", "tabs", "dropdown-menu"];
  // Containers that receive programmatic focus only (dialog panels) or are not interactive.
  const NON_INTERACTIVE = [
    "alert-dialog",
    "badge",
    "dialog",
    "drawer",
    "label",
    "sheet",
    "skeleton",
    "sonner",
    "table",
  ];

  it("classifies every primitive", () => {
    const files = readdirSync(UI)
      .map((f) => f.replace(/\.tsx$/, ""))
      .sort();
    expect(files).toEqual([...INTERACTIVE, ...NON_INTERACTIVE].sort());
  });

  it.each(INTERACTIVE)("%s draws a focus-visible ring or highlight", (name) => {
    const source = readFileSync(join(UI, `${name}.tsx`), "utf8");
    expect(source).toMatch(/focus-visible:|data-\[highlighted\]|focus:bg-/);
  });

  it("never weakens the ring to a translucent color", () => {
    for (const name of INTERACTIVE) {
      const source = readFileSync(join(UI, `${name}.tsx`), "utf8");
      expect(source, name).not.toMatch(/focus-visible:ring-ring\/\d+/);
    }
  });
});
