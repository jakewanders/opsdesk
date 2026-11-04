import { ViewTransition, type ReactNode } from "react";

/**
 * Wrap the top-level element a `page.tsx` returns. Pages (not layouts) are wrapped because a layout persists across
 * navigations, so its enter and exit would never run. Which animation plays depends on the link:
 * `<Link transitionTypes={["nav-forward"]}>` slides in from the right, `["nav-back"]` from the left, and a link with no
 * type (the sidebar, a browser back button) crossfades. Where the browser has no View Transitions API nothing animates and
 * the page simply swaps. Styles are in globals.css; reduced motion removes all of it.
 */
const BY_TYPE = {
  "nav-forward": "nav-forward",
  "nav-back": "nav-back",
  default: "page-fade",
} as const;

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter={BY_TYPE} exit={BY_TYPE} default="none">
      {children}
    </ViewTransition>
  );
}
