export type AuthFailure =
  | "invalid_credentials"
  | "email_not_confirmed"
  | "rate_limited"
  | "captcha"
  | "signups_disabled"
  | "weak_password"
  | "unavailable";

type AuthLike = { status?: number; code?: string; name?: string } | null | undefined;

/**
 * Maps a Supabase Auth error to a small set of outcomes. Everything that could reveal whether an
 * account exists (wrong password, unknown email, "user already registered") collapses into the same
 * outcome, so the response never discloses account existence.
 */
export function classifyAuthError(error: AuthLike): AuthFailure {
  if (!error) return "unavailable";
  const code = error.code ?? "";
  if (
    error.status === 429 ||
    code === "over_request_rate_limit" ||
    code === "over_email_send_rate_limit"
  ) {
    return "rate_limited";
  }
  if (code === "captcha_failed") return "captcha";
  if (code === "email_not_confirmed") return "email_not_confirmed";
  if (code === "signup_disabled" || code === "email_provider_disabled") return "signups_disabled";
  if (code === "weak_password") return "weak_password";
  if (code === "invalid_credentials" || code === "user_not_found") return "invalid_credentials";
  if (code === "user_already_exists" || code === "email_exists") return "invalid_credentials";
  if (error.status === 400 || error.status === 422) return "invalid_credentials";
  return "unavailable";
}

/** Plain-language messages shown to the person. Deliberately identical for every credential failure. */
export const AUTH_MESSAGES: Record<AuthFailure, string> = {
  invalid_credentials: "The email or password is not correct.",
  email_not_confirmed: "Confirm your email first. Open the message we sent and select the link.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  captcha: "We could not verify you are human. Complete the check again.",
  signups_disabled: "Sign-ups are turned off right now.",
  weak_password: "Choose a stronger password.",
  unavailable: "We could not reach the sign-in service. Try again in a moment.",
};
