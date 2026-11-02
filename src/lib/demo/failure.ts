/**
 * What went wrong while opening the demo, in words a visitor can act on. Every failure is retryable except a
 * signed-in member (they have a workspace to open). The demo flow never shows success for a failure.
 */
export type DemoFailureKind = "rate_limit" | "captcha" | "unavailable" | "setup" | "member";

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

export function classifyDemoFailure(input: DemoFailureInput): DemoFailure {
  const { step, status, code, network, requestId } = input;
  let kind: DemoFailureKind;
  if (status === 429 || (code && RATE_LIMIT_CODES.has(code))) kind = "rate_limit";
  else if (code === "captcha_failed" || (step === "signin" && status === 400 && !code))
    kind = "captcha";
  else if (step === "bootstrap" && status === 403 && code === "GUEST_ONLY") kind = "member";
  else if (
    network ||
    (status !== undefined && status >= 500) ||
    code === "anonymous_provider_disabled"
  )
    kind = "unavailable";
  else kind = "setup";
  return { kind, ...COPY[kind], ...(requestId ? { requestId } : {}) };
}
