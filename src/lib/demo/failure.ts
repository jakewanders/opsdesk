/**
 * What went wrong while opening the demo, in words a visitor can act on. Every failure is retryable except a
 * signed-in member (they have a workspace to open). The demo flow never shows success for a failure.
 */
export type DemoFailureKind =
  "rate_limit" | "captcha" | "unavailable" | "disabled" | "setup" | "member";

export type DemoFailureInput = {
  /** Where it failed: the anonymous sign-in, or the bootstrap request. */
  step: "signin" | "bootstrap";
  /** HTTP status when there was a response. */
  status?: number;
  /** Supabase Auth `code` or API error `code`. */
  code?: string;
  /** The request never got an answer (offline, DNS, paused project). */
  network?: boolean;
  requestId?: string;
};

export type DemoFailure = {
  kind: DemoFailureKind;
  title: string;
  message: string;
  retryable: boolean;
  requestId?: string;
  /** The error code from Supabase Auth or the API, shown as a reference and logged to the console. */
  code?: string;
};

const COPY: Record<DemoFailureKind, Pick<DemoFailure, "title" | "message" | "retryable">> = {
  rate_limit: {
    title: "The demo is busy right now",
    message:
      "A lot of people are trying the demo at the moment. Wait a minute, then try again. Nothing was created.",
    retryable: true,
  },
  captcha: {
    title: "We could not confirm you are a person",
    message:
      "The security check did not pass, so no demo was started. Try again. If it keeps failing, turn off content blockers for this site.",
    retryable: true,
  },
  unavailable: {
    title: "The demo is unavailable right now",
    message:
      "We could not reach the demo service. It may be paused or restarting. Try again in a moment.",
    retryable: true,
  },
  disabled: {
    title: "The live demo is switched off right now",
    message:
      "Guest demos are turned off on this site at the moment, so nothing was started. Please check back soon.",
    retryable: false,
  },
  setup: {
    title: "We could not set up your demo",
    message: "Something went wrong while preparing your workspace. Try again.",
    retryable: true,
  },
  member: {
    title: "You are signed in",
    message:
      "The live demo is for guest visitors. Open your workspace, or sign out to try the demo.",
    retryable: false,
  },
};

const RATE_LIMIT_CODES = new Set([
  "over_request_rate_limit",
  "over_email_send_rate_limit",
  "over_sms_send_rate_limit",
  "RATE_LIMITED",
  "DEMO_CAPACITY",
  "DEMO_QUOTA",
]);

/** Supabase Auth answers these when the project has guest sign-in switched off: the demo cannot start, whatever the visitor does. */
const DISABLED_CODES = new Set(["anonymous_provider_disabled", "signup_disabled"]);

export function classifyDemoFailure(input: DemoFailureInput): DemoFailure {
  const { step, status, code, network, requestId } = input;
  let kind: DemoFailureKind;
  if (status === 429 || (code && RATE_LIMIT_CODES.has(code))) kind = "rate_limit";
  else if (code === "captcha_failed" || (step === "signin" && status === 400 && !code))
    kind = "captcha";
  else if (step === "bootstrap" && status === 403 && code === "GUEST_ONLY") kind = "member";
  else if (code && DISABLED_CODES.has(code)) kind = "disabled";
  else if (network || (status !== undefined && status >= 500)) kind = "unavailable";
  else kind = "setup";
  return { kind, ...COPY[kind], ...(requestId ? { requestId } : {}), ...(code ? { code } : {}) };
}
