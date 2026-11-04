import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { selectWorkspaceAction } from "@/lib/org/actions";
import { listWorkspaces } from "@/lib/org/workspace-core";
import { PageTransition } from "@/components/layout/page-transition";

export const metadata: Metadata = { title: "Choose a workspace" };

/** Several workspaces and none selected yet: the user chooses explicitly (no silent default). */
export default async function ChooseWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/app/workspaces");
  const workspaces = await listWorkspaces(await createClient(), user.id);
  if (workspaces.length === 0) redirect("/app/setup");
  const { notice } = await searchParams;

  return (
    <PageTransition>
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Choose a workspace</h1>
          <p className="text-muted-foreground">
            You belong to more than one workspace. Pick the one to open.
          </p>
        </header>
        {notice === "not-found" ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive-subtle p-3 text-sm"
          >
            That workspace was not found. Choose one from the list.
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {workspaces.map((w) => (
            <li key={w.id}>
              <form
                action={selectWorkspaceAction}
                className="flex items-center justify-between gap-4 rounded-lg border p-4"
              >
                <input type="hidden" name="orgId" value={w.id} />
                <div className="min-w-0">
                  <p className="truncate font-medium">{w.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {w.kind === "demo" ? "Demo workspace" : `Your role: ${w.role}`}
                  </p>
                </div>
                <Button type="submit">Open {w.name}</Button>
              </form>
            </li>
          ))}
        </ul>
        {user.isAnonymous ? null : (
          <p className="text-sm">
            <Link href="/app/setup" className="underline underline-offset-2">
              Create another workspace
            </Link>
          </p>
        )}
      </div>
    </PageTransition>
  );
}
