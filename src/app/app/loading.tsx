import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/shared/skeletons";

/**
 * Shown the instant a link in the app is pressed, while the next page's server read finishes. The sidebar stays; only the
 * page area swaps, so a click answers at once instead of freezing on the old page.
 */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <TableSkeleton rows={6} label="Loading page" />
    </div>
  );
}
