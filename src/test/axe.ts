import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe-core against a rendered container. jsdom has no layout or paint, so rules that
 * need them (color-contrast, region landmarks on fragments) are covered by token contrast
 * tests and browser checks instead.
 */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
  );
  expect(summary).toEqual([]);
}
