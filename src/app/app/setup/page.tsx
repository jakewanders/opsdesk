import type { Metadata } from "next";
import { WorkspaceSetupForm } from "@/components/org/workspace-setup-form";
import { createWorkspaceAction } from "@/lib/org/actions";

export const metadata: Metadata = { title: "Set up your workspace" };

/** Where a signed-in member with no organization lands (the route guard sends them here). */
export default function SetupPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Set up your workspace</h1>
        <p className="text-muted-foreground">
          A workspace holds your customers, pipeline and tasks. You can invite your team later.
        </p>
      </header>
      <WorkspaceSetupForm action={createWorkspaceAction} />
    </div>
  );
}
