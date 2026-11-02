import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

// Auth pages are rendered per request and never shared-cached (PRD 5.2).
async function Dynamic({ children }: { children: ReactNode }) {
  await connection();
  return <>{children}</>;
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6 outline-none"
      >
        <Suspense fallback={<div aria-busy="true" />}>
          <Dynamic>{children}</Dynamic>
        </Suspense>
      </main>
    </>
  );
}
