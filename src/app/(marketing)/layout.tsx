import type { ReactNode } from "react";

// Landing, privacy, and terms are static and cacheable (PRD 3.3); no per-user data here.
export default function MarketingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
