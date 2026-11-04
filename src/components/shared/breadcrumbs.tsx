import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

export type Crumb = { label: string; href?: string; node?: ReactNode };

/**
 * Breadcrumbs for a detail page: the trail from a list to this record. Every crumb but the last is a link; the last is the current
 * page (`aria-current="page"`, not a link). A crumb can bring its own `node` (a link that already knows the list's remembered filters).
 */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${item.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {last ? (
                <span aria-current="page" className="truncate font-medium text-foreground">
                  {item.label}
                </span>
              ) : (
                (item.node ??
                (item.href ? (
                  <Link
                    href={item.href}
                    transitionTypes={["nav-back"]}
                    className="touch-link underline-offset-4 hover:underline"
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span>{item.label}</span>
                )))
              )}
              {last ? null : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
