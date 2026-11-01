import Link from "next/link";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6"
    >
      <StatePanel
        title="Page not found"
        description="The page you asked for does not exist or has moved. Check the address, or start from the home page."
        actions={
          <Link href="/" className={cn(buttonVariants())}>
            Go to home
          </Link>
        }
      />
    </main>
  );
}
