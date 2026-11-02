export type Outcome = {
  title: string;
  /** What the person can do next, in words. */
  steps: string;
  /** True when opening the link again, or signing in differently, can help; false for a dead link. */
  recoverable: boolean;
};

/** Plain-language outcomes for each way an invitation can be refused (the codes are the API's, SIT-224). */
export const OUTCOMES: Record<string, Outcome> = {
  INVITATION_INVALID: {
    title: "This invitation link is not valid",
    steps:
      "Check that the whole link was copied, or ask the person who invited you to send a new one.",
    recoverable: false,
  },
  INVITATION_REVOKED: {
    title: "This invitation was withdrawn",
    steps: "Ask the person who invited you to send a new invitation.",
    recoverable: false,
  },
  INVITATION_USED: {
    title: "This invitation was already used",
    steps:
      "If you used it, sign in and open the workspace from your workspace list. Otherwise ask for a new invitation.",
    recoverable: false,
  },
  INVITATION_EXPIRED: {
    title: "This invitation has expired",
    steps: "Invitations last 7 days. Ask the person who invited you to send a new one.",
    recoverable: false,
  },
  EMAIL_UNVERIFIED: {
    title: "Confirm your email address first",
    steps:
      "Open the confirmation email we sent when you created your account, then open the invitation link again.",
    recoverable: true,
  },
  EMAIL_MISMATCH: {
    title: "This invitation is for a different email address",
    steps: "Sign out and sign in with the address the invitation was sent to.",
    recoverable: true,
  },
  RATE_LIMITED: {
    title: "Too many attempts",
    steps: "Wait about 15 minutes, then open the invitation link again.",
    recoverable: true,
  },
  ACCOUNT_REQUIRED: {
    title: "Create an account to accept this invitation",
    steps: "Demo guests cannot join a workspace. Create an account with the invited email address.",
    recoverable: true,
  },
};

export const GENERIC_OUTCOME: Outcome = {
  title: "The invitation could not be checked",
  steps: "Check your connection and try again.",
  recoverable: true,
};

export function outcomeFor(code: string | undefined): Outcome {
  return (code && OUTCOMES[code]) || GENERIC_OUTCOME;
}
