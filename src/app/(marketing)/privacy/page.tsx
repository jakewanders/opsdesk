import type { Metadata } from "next";
import Link from "next/link";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Privacy | OpsDesk" };

export default function Page() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-[60vh] w-full max-w-2xl flex-col justify-center p-6"
    >
      <StatePanel
        title="Privacy"
        description="The full privacy notice for the live demo is still being written and will be published before the demo opens."
        actions={
          <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
            Back to home
          </Link>
        }
      />
    </main>
  );
}
