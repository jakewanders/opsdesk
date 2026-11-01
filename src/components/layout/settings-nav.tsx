"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type SettingsLink = { href: string; label: string };

/** Sub-navigation for /app/settings/*. The server layout passes only links whose page is on. */
export function SettingsNav({ links }: { links: readonly SettingsLink[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="mb-6 flex flex-wrap gap-1 border-b border-border pb-2">
      {links.map((link) => {
        const active = pathname === link.href;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring",
              active && "bg-accent font-medium text-accent-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
