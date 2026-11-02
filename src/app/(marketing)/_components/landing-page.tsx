import Link from "next/link";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  CustomerIllustration,
  PipelineIllustration,
  QuoteIllustration,
  TaskIllustration,
} from "./illustrations";

type LandingPageProps = {
  /** Source code link. The "View Source Code" button renders only when this is set. */
  repoUrl?: string;
};

const FEATURES = [
  {
    id: "customers",
    title: "Every customer, with the whole story",
    body: "Each customer has one page: contact details, their opportunities and tasks, quotes, and a timeline of every change. Archive instead of deleting, so history is never lost.",
    figure: <CustomerIllustration />,
    caption: "Illustration of a customer record. Not real data.",
  },
  {
    id: "tasks",
    title: "Tasks that know what time it is for your business",
    body: "Due dates are judged in your organization's time zone, so a task due today is not overdue until today is over. Overdue work is marked with a label as well as a color.",
    figure: <TaskIllustration />,
    caption: "Illustration of task states. Not real data.",
  },
  {
    id: "quotes",
    title: "Quotes with totals you can check",
    body: "Line items, a discount, and a tax rate produce a total that is calculated on the server in whole cents, so rounding never drifts. A sent quote is locked; changing it creates a revision.",
    figure: <QuoteIllustration />,
    caption: "Illustration of quote totals. Not real data.",
  },
] as const;

const DESIGN_NOTES = [
  {
    title: "Isolated by the database",
    body: "Every business table is meant to be protected by row level security, so one workspace cannot read another's rows even if application code has a bug.",
  },
  {
    title: "One API for everyone",
    body: "Guests and signed-in users go through the same validated endpoints, with the same permission checks and the same database.",
  },
  {
    title: "Changes that leave a record",
    body: "A change and its activity entry are saved in the same database transaction, so the timeline cannot disagree with the data.",
  },
];

const linkButton = "h-10 px-4 text-sm";

export function LandingPage({ repoUrl }: LandingPageProps) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link
            href="/"
            className="touch-link rounded-md px-1 text-base font-semibold tracking-tight"
          >
            OpsDesk
          </Link>
          <nav aria-label="Primary" className="flex items-center gap-1 text-sm sm:gap-4">
            <a
              href="#technical-overview"
              className="hidden rounded-md px-2 py-1.5 hover:bg-muted sm:inline"
            >
              Technical overview
            </a>
            <Link href="/demo" className={cn(buttonVariants({ size: "sm" }))}>
              Try Live Demo
            </Link>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="outline-none">
        <section className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1fr_1.15fr] lg:items-center lg:py-20">
          <div className="flex flex-col gap-6">
            <h1 className="max-w-[16ch] text-[clamp(2.5rem,6vw,4rem)] leading-[1.05] font-semibold tracking-[-0.025em] text-balance">
              A simpler way to run your business
            </h1>
            <p className="max-w-[52ch] text-lg leading-relaxed text-muted-foreground">
              Customers, pipeline, quotes, tasks, and insights in one place, built for small service
              businesses.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/demo" className={cn(buttonVariants({ size: "lg" }), linkButton)}>
                Try Live Demo
              </Link>
              {repoUrl ? (
                <a
                  href={repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(buttonVariants({ variant: "outline", size: "lg" }), linkButton)}
                >
                  View Source Code
                </a>
              ) : null}
              <a
                href="#technical-overview"
                className={cn(buttonVariants({ variant: "ghost", size: "lg" }), linkButton)}
              >
                Technical Overview
              </a>
            </div>
            <p className="max-w-[52ch] text-sm text-muted-foreground">
              No sign-up needed. The demo opens a private workspace filled with fictional records.
            </p>
          </div>
          <figure className="flex flex-col gap-2">
            <PipelineIllustration />
            <figcaption className="text-sm text-muted-foreground">
              Illustration of the sales pipeline: a deal moves from Proposal to Negotiation. Not
              real data.
            </figcaption>
          </figure>
        </section>

        <section
          aria-labelledby="features-heading"
          className="border-t border-border bg-secondary/30"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-14 px-4 py-14 sm:px-6 lg:py-20">
            <h2
              id="features-heading"
              className="max-w-[28ch] text-3xl font-semibold tracking-tight text-balance"
            >
              What it covers
            </h2>
            {FEATURES.map((feature, index) => (
              <article
                key={feature.id}
                aria-labelledby={`${feature.id}-title`}
                className="grid grid-cols-1 items-center gap-8 lg:grid-cols-2 lg:gap-14"
              >
                <div className={cn("flex flex-col gap-3", index % 2 === 1 && "lg:order-2")}>
                  <h3
                    id={`${feature.id}-title`}
                    className="max-w-[30ch] text-xl font-semibold tracking-tight"
                  >
                    {feature.title}
                  </h3>
                  <p className="max-w-[60ch] leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
                <figure className="flex flex-col gap-2">
                  {feature.figure}
                  <figcaption className="text-sm text-muted-foreground">
                    {feature.caption}
                  </figcaption>
                </figure>
              </article>
            ))}
          </div>
        </section>

        <section
          id="technical-overview"
          aria-labelledby="overview-heading"
          className="mx-auto flex max-w-6xl scroll-mt-4 flex-col gap-8 px-4 py-14 sm:px-6 lg:py-20"
        >
          <div className="flex flex-col gap-3">
            <h2 id="overview-heading" className="text-3xl font-semibold tracking-tight">
              How it is designed
            </h2>
            <p className="max-w-[62ch] leading-relaxed text-muted-foreground">
              A single Next.js application talks to a Postgres database through validated server
              endpoints. This page is static, so it stays readable even if the backend is down.
            </p>
          </div>
          <ul
            aria-label="Request path"
            className="flex flex-col items-stretch gap-2 text-sm font-medium sm:flex-row sm:items-center"
          >
            {[
              "Browser",
              "Next.js route handlers (Zod validation)",
              "Postgres with row level security",
            ].map((step, i, all) => (
              <li key={step} className="flex flex-1 items-center gap-2 sm:contents">
                <span className="flex-1 rounded-lg border border-border bg-card px-4 py-3 text-center">
                  {step}
                </span>
                {i < all.length - 1 ? (
                  <span aria-hidden="true" className="px-1 text-muted-foreground">
                    →
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
            {DESIGN_NOTES.map((note) => (
              <div key={note.title} className="flex flex-col gap-2">
                <h3 className="text-base font-semibold">{note.title}</h3>
                <p className="max-w-[44ch] text-sm leading-relaxed text-muted-foreground">
                  {note.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section
          aria-labelledby="disclosure-heading"
          className="border-t border-border bg-secondary/30"
        >
          <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-12 sm:px-6">
            <h2 id="disclosure-heading" className="text-xl font-semibold tracking-tight">
              An engineering demonstration
            </h2>
            <p className="max-w-[70ch] leading-relaxed text-muted-foreground">
              OpsDesk is a portfolio project, not an operating business. It is in active
              development, so some areas described above are still being built. All demo records are
              fictional. It is not certified for HIPAA, SOC 2, or PCI DSS, so do not enter real
              customer, health, or payment data.
            </p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <p>OpsDesk, a portfolio project</p>
          <nav aria-label="Footer" className="flex flex-wrap gap-4">
            <Link href="/privacy" className="rounded-md underline-offset-4 hover:underline">
              Privacy
            </Link>
            <Link href="/terms" className="rounded-md underline-offset-4 hover:underline">
              Terms
            </Link>
            {repoUrl ? (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md underline-offset-4 hover:underline"
              >
                Source code
              </a>
            ) : null}
          </nav>
        </div>
      </footer>
    </>
  );
}
