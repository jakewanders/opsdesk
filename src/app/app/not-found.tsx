import Link from "next/link";
import { StatePanel } from "@/components/shared/state-panel";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function AppNotFound() {
  return (
    <StatePanel
      title="Not found"
      description="This record does not exist, or you do not have access to it."
      actions={
        <Link href="/app" className={cn(buttonVariants({ variant: "outline" }))}>
          Back to dashboard
        </Link>
      }
    />
  );
}
