/**
 * What to tell someone who followed an e-mail link that did not work. Supabase reports a failed link in the URL fragment
 * (`#error=access_denied&error_code=otp_expired&...`), which the server never sees, so the sign-in page reads it in the browser.
 */
export type LinkProblem = { title: string; message: string };

export function linkProblemFromHash(hash: string, fallback: string): LinkProblem {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const code = params.get("error_code");
  if (code === "otp_expired") {
    return {
      title: "That link was already used or has expired",
      message:
        'E-mail links work once. If you already confirmed your address, sign in below. If not, create the account again with the same e-mail address to get a new confirmation link, or use "Forgot your password?" for a reset link.',
    };
  }
  return { title: "Link problem", message: fallback };
}
