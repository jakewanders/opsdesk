"use server";

import { redirect } from "next/navigation";
import type { WorkspaceFormState } from "./form-state";
import { getCurrentUser } from "@/lib/supabase/current-user";
import { createClient } from "@/lib/supabase/server";
import { rememberWorkspace } from "./remember-workspace";
import { createWorkspace, isMemberOf } from "./workspace-core";

const text = (data: FormData, key: string) => {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
};

/** Workspace setup form: creates the workspace, remembers it, and opens the app. */
export async function createWorkspaceAction(
  previous: WorkspaceFormState,
  formData: FormData,
): Promise<WorkspaceFormState> {
  const values = {
    name: text(formData, "name"),
    industry: text(formData, "industry"),
    timezone: text(formData, "timezone"),
  };
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/app/setup");
  const result = await createWorkspace(await createClient(), user, values);
  if (!result.ok) {
    return {
      status: "error",
      attempt: previous.attempt + 1,
      message: result.reason === "invalid" ? undefined : result.message,
      fieldErrors: result.fieldErrors,
      values,
      guest: result.reason === "guest",
    };
  }
  await rememberWorkspace(result.id);
  redirect("/app");
}

/** Switching workspaces: only a workspace the caller belongs to can be chosen; anything else is ignored. */
export async function selectWorkspaceAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgId = text(formData, "orgId");
  if (!(await isMemberOf(await createClient(), user.id, orgId)))
    redirect("/app/workspaces?notice=not-found");
  await rememberWorkspace(orgId.toLowerCase());
  redirect("/app");
}
