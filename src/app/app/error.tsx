"use client";

import { ErrorPanel } from "@/components/shared/error-panel";

// Renders inside the app shell, so navigation stays available when a page fails.
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorPanel {...props} />;
}
