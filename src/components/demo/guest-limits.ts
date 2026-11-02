/** The standing list of what a guest cannot do and why (also shown on the settings pages). */
export const GUEST_LIMITS: ReadonlyArray<{ feature: string; reason: string }> = [
  {
    feature: "Invite members",
    reason: "The demo is a single-person workspace. Create an account to invite your team.",
  },
  { feature: "Billing", reason: "The demo has no billing. Payments are never taken in the demo." },
  {
    feature: "Integrations",
    reason: "Integrations connect to real accounts, so they are off in the demo.",
  },
  { feature: "Send external email", reason: "The demo never sends email to anyone outside it." },
  {
    feature: "Upload files",
    reason: "File uploads are off in the demo so no real documents are stored.",
  },
  {
    feature: "Create a real workspace",
    reason: "Real workspaces need an account. Demo data is not carried over to it.",
  },
];
