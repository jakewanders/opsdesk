"use server";

import { redirect } from "next/navigation";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/server";
import { zodFieldErrors } from "@/lib/api/to-api-error";
import { logIn, signUp } from "./flows";
import { loginSchema, signupSchema } from "./schemas";
import type { AuthFormState } from "./form-state";
import { safeNextPath } from "./safe-redirect";

const text = (data: FormData, key: string) => {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
};

function failed(
  previous: AuthFormState,
  rest: Pick<AuthFormState, "message" | "fieldErrors" | "values">,
): AuthFormState {
  return { status: "error", attempt: previous.attempt + 1, ...rest };
}

export async function loginAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData, "email").trim() };
  const parsed = loginSchema.safeParse({
    email: text(formData, "email"),
    password: text(formData, "password"),
    captchaToken: text(formData, "captchaToken"),
  });
  if (!parsed.success)
    return failed(previous, { fieldErrors: zodFieldErrors(parsed.error), values });

  const result = await logIn(await createClient(), parsed.data);
  if (!result.ok) return failed(previous, { message: result.message, values });
  redirect(safeNextPath(text(formData, "next")));
}

export async function signupAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData, "email").trim() };
  const parsed = signupSchema.safeParse({
    email: text(formData, "email"),
    password: text(formData, "password"),
    captchaToken: text(formData, "captchaToken"),
  });
  if (!parsed.success)
    return failed(previous, { fieldErrors: zodFieldErrors(parsed.error), values });

  // The confirmation link must go to the exact allowlisted callback on the configured origin.
  const callback = new URL("/auth/callback", getPublicEnv().NEXT_PUBLIC_APP_URL).toString();
  const result = await signUp(await createClient(), parsed.data, callback);
  if (!result.ok) return failed(previous, { message: result.message, values });
  if (result.next === "signed-in") redirect("/app");
  return { status: "check-email", attempt: previous.attempt, values };
}

/** Signs the current user out (clears the session cookies) and returns to the login page. */
export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
