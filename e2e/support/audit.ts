import type { Page } from "@playwright/test";

export type Audit = {
  overflow: number;
  small: Array<{ tag: string; name: string; w: number; h: number }>;
  clipped: string[];
};

/**
 * What the mobile pass checks on the page as it is now: horizontal page overflow (the page must never scroll sideways, only
 * a table's own scroll region may), and visible interactive controls smaller than 44 x 44 CSS px. Links inside running text
 * and the visually hidden skip link are exempt (WCAG 2.5.8 allows inline links in a sentence).
 */
export async function audit(page: Page, minTarget = 44): Promise<Audit> {
  // dialogs and menus scale in; measure them at rest
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
  return page.evaluate((min) => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const sel =
      "a[href], button, input:not([type=hidden]), select, textarea, [role=tab], [role=menuitem], [role=button], summary";
    const small: Audit["small"] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (
        r.width === 0 ||
        r.height === 0 ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        continue;
      if (r.width <= 2 || r.height <= 2) continue; // visually hidden (sr-only, skip link)
      if (el.closest("[aria-hidden=true]")) continue;
      // a checkbox or radio is clicked through its label: measure the label
      const target =
        el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
          ? (el.closest("label") ?? el)
          : el;
      const tr = target.getBoundingClientRect();
      // a link stretched over its whole card (an ::after covering the card) is as big as the card
      if (getComputedStyle(el, "::after").position === "absolute") continue;
      // inline link inside a sentence
      if (el.tagName === "A" && style.display === "inline") {
        const parent = el.parentElement;
        if (
          parent &&
          (parent.textContent ?? "").trim().length > (el.textContent ?? "").trim().length + 8
        )
          continue;
      }
      if (tr.width < min - 0.5 || tr.height < min - 0.5) {
        small.push({
          tag: el.tagName.toLowerCase(),
          name: (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("id") ?? "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40),
          w: Math.round(tr.width),
          h: Math.round(tr.height),
        });
      }
    }
    return { overflow, small, clipped: [] };
  }, minTarget);
}
