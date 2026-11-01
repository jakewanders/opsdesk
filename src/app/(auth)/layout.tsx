import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";

// Auth pages are rendered per request and never shared-cached (PRD 5.2).
async function Dynamic({ children }: { children: ReactNode }) {
  await connection();
  return <>{children}</>;
}

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6"
    >
      <Suspense fallback={<div aria-busy="true" />}>
        <Dynamic>{children}</Dynamic>
      </Suspense>
    </main>
  );
}
