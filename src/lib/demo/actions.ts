"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { restartDemo } from "./restart";

export type RestartState = { error?: string };

/** "Start a new demo": restarts the caller's demo with their existing guest session, then opens the app. */
export async function restartDemoAction(): Promise<RestartState> {
  const result = await restartDemo(await createClient());
  if (!result.ok) return { error: result.message };
  redirect("/app");
}
