"use client";

import Link from "next/link";
import { useListBackUrl } from "@/lib/api-client/use-remember-list";
import type { ListKey } from "@/lib/api-client/list-memory";

/** A link to a list that returns to it with the filters it had when the person left (see `list-memory.ts`). */
export function ListLink({
  list,
  children,
  className = "touch-link underline-offset-4 hover:underline",
}: {
  list: ListKey;
  children: React.ReactNode;
  className?: string;
}) {
  const href = useListBackUrl(list);
  return (
    <Link href={href} transitionTypes={["nav-back"]} className={className}>
      {children}
    </Link>
  );
}
