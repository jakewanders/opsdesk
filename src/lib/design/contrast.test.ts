import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "@/lib/design/contrast";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

function tokens(selector: ":root" | ".dark"): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// [foreground token, background token]: text needs 4.5:1 (WCAG 1.4.3)
const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["success-foreground", "success"],
  ["warning-foreground", "warning"],
  ["info-foreground", "info"],
  ["primary", "background"],
  ["destructive", "background"],
  ["destructive", "destructive-subtle"],
  ["success", "success-subtle"],
  ["warning", "warning-subtle"],
  ["info", "info-subtle"],
  ["sidebar-foreground", "sidebar"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

// Control borders and focus rings need 3:1 (WCAG 1.4.11)
const NON_TEXT_PAIRS: [string, string][] = [
  ["input", "background"],
  ["input", "card"],
  ["ring", "background"],
  ["ring", "card"],
];

describe.each([
  [":root", "light"],
  [".dark", "dark"],
] as const)("%s (%s theme) contrast", (selector, name) => {
  const t = tokens(selector);

  it("defines every token used in the pairs", () => {
    for (const key of [...TEXT_PAIRS, ...NON_TEXT_PAIRS].flat()) {
      expect(t[key], `${name}: --${key}`).toBeDefined();
    }
  });

  it.each(TEXT_PAIRS)("text --%s on --%s is at least 4.5:1", (fg, bg) => {
    expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NON_TEXT_PAIRS)("control --%s against --%s is at least 3:1", (fg, bg) => {
    expect(contrastRatio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});
