"use server";

import { redirect } from "next/navigation";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/server";
import { resolveUser } from "@/lib/supabase/resolve-user";
import { AUTH_MESSAGES } from "./auth-errors";
import { zodFieldErrors } from "@/lib/api/to-api-error";
import { logIn, requestPasswordReset, setNewPassword, signUp } from "./flows";
import { forgotPasswordSchema, loginSchema, resetPasswordSchema, signupSchema } from "./schemas";
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

  // The confirmation link must go to an exact allowlisted callback on the configured origin. Signing up from an invitation
  // returns to the invitation page afterwards (`?next=/invite` is one of the two allowlisted forms).
  const next = safeNextPath(text(formData, "next"));
  const callback =
    new URL("/auth/callback", getPublicEnv().NEXT_PUBLIC_APP_URL).toString() +
    (next === "/invite" ? "?next=/invite" : "");
  const result = await signUp(await createClient(), parsed.data, callback);
  if (!result.ok) return failed(previous, { message: result.message, values });
  if (result.next === "signed-in") redirect(next);
  return { status: "check-email", attempt: previous.attempt, values };
}

/** Signs the current user out (clears the session cookies) and returns to the login page. */
export async function logoutAction(formData?: FormData): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // Signing out to use the invited account returns to the invitation page afterwards.
  const next = formData ? safeNextPath(text(formData, "next")) : "";
  redirect(next === "/invite" ? `/login?next=${encodeURIComponent(next)}` : "/login");
}

export async function forgotPasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const values = { email: text(formData, "email").trim() };
  const parsed = forgotPasswordSchema.safeParse({
    email: text(formData, "email"),
    captchaToken: text(formData, "captchaToken"),
  });
  if (!parsed.success)
    return failed(previous, { fieldErrors: zodFieldErrors(parsed.error), values });

  // The link goes to the allowlisted callback, which sends the recovery session on to /reset-password.
  const redirectTo = new URL(
    "/auth/callback?next=/reset-password",
    getPublicEnv().NEXT_PUBLIC_APP_URL,
  ).toString();
  const result = await requestPasswordReset(await createClient(), parsed.data, redirectTo);
  if (!result.ok) return failed(previous, { message: result.message, values });
  return { status: "check-email", attempt: previous.attempt, values };
}

export async function resetPasswordAction(
  previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = resetPasswordSchema.safeParse({
    password: text(formData, "password"),
    confirm: text(formData, "confirm"),
  });
  if (!parsed.success) return failed(previous, { fieldErrors: zodFieldErrors(parsed.error) });

  const supabase = await createClient();
  // Only a signed-in (recovery) session may set a password; verify with Supabase Auth, not the cookie alone.
  if (!(await resolveUser(supabase))) {
    return failed(previous, { message: AUTH_MESSAGES.no_session });
  }
  const result = await setNewPassword(supabase, parsed.data.password);
  if (!result.ok) return failed(previous, { message: result.message });
  redirect("/app");
}
