import Link from "next/link";
import type { ReactNode } from "react";

type LegalPageProps = {
  title: string;
  /** Plain-language summary shown first. */
  intro: ReactNode;
  children: ReactNode;
};

/** Last time the legal copy was reviewed against the product. Update with every copy change. */
export const LEGAL_LAST_UPDATED = "1 November 2026";

/**
 * Shared layout for /privacy and /terms: a readable column with a back link and cross links.
 * Static (no data, no env) so both pages are prerendered and cacheable.
 */
export function LegalPage({ title, intro, children }: LegalPageProps) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
          <Link
            href="/"
            className="touch-link rounded-md px-1 text-base font-semibold tracking-tight"
          >
            OpsDesk
          </Link>
          <nav aria-label="Legal" className="flex gap-4 text-sm">
            <Link href="/privacy" className="rounded-md underline-offset-4 hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="rounded-md underline-offset-4 hover:underline">
              Terms
            </Link>
          </nav>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="outline-none">
        <article className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6">
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">Last updated {LEGAL_LAST_UPDATED}</p>
            <div className="max-w-[68ch] leading-relaxed">{intro}</div>
          </div>
          {children}
        </article>
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <Link href="/" className="rounded-md underline-offset-4 hover:underline">
            Back to home
          </Link>
          <p>OpsDesk, a portfolio project</p>
        </div>
      </footer>
    </>
  );
}

type SectionProps = { heading: string; children: ReactNode };

/** A titled block of prose. Headings are h2 so the page title stays the only h1. */
export function LegalSection({ heading, children }: SectionProps) {
  return (
    <section className="flex max-w-[68ch] flex-col gap-3 leading-relaxed">
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      {children}
    </section>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p
      role="note"
      className="rounded-lg border border-warning/40 bg-warning-subtle p-4 text-sm leading-relaxed"
    >
      {children}
    </p>
  );
}
