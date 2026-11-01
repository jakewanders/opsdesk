import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTH_MESSAGES, classifyAuthError, type AuthFailure } from "./auth-errors";
import type { LoginInput, SignupInput } from "./schemas";

export type FlowResult =
  | { ok: true; next: "signed-in" | "check-email" }
  | { ok: false; failure: AuthFailure; message: string };

const fail = (failure: AuthFailure): FlowResult => ({
  ok: false,
  failure,
  message: AUTH_MESSAGES[failure],
});

/** Password sign-in. A bad email and a bad password are indistinguishable to the caller. */
export async function logIn(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  input: LoginInput,
): Promise<FlowResult> {
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: input.email,
      password: input.password,
      options: { captchaToken: input.captchaToken },
    });
    return error ? fail(classifyAuthError(error)) : { ok: true, next: "signed-in" };
  } catch {
    return fail("unavailable");
  }
}

/**
 * Sign-up. The caller always learns the same thing for a new and an already-registered address
 * ("check your email"), so the form cannot be used to find out who has an account. With email
 * confirmation on (the default, local and hosted) no session is created until the link is used.
 */
export async function signUp(
  supabase: SupabaseClient<any, any, any>, // eslint-disable-line @typescript-eslint/no-explicit-any -- generic over any Database
  input: SignupInput,
  emailRedirectTo: string,
): Promise<FlowResult> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: { captchaToken: input.captchaToken, emailRedirectTo },
    });
    if (error) {
      // "already registered" must look like success.
      if (error.code === "user_already_exists" || error.code === "email_exists") {
        return { ok: true, next: "check-email" };
      }
      return fail(classifyAuthError(error));
    }
    return { ok: true, next: data.session ? "signed-in" : "check-email" };
  } catch {
    return fail("unavailable");
  }
}
