"use client";

import { ErrorPanel } from "@/components/shared/error-panel";

export default function GlobalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6"
    >
      <ErrorPanel {...props} />
    </main>
  );
}
