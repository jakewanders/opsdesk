import { ThemeToggle } from "@/components/layout/theme-toggle";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8">
      <ThemeToggle />
      <h1 className="text-3xl font-semibold tracking-tight">OpsDesk</h1>
      <p className="text-muted-foreground">
        Placeholder home route. The product lands in later milestones.
      </p>
    </main>
  );
}
