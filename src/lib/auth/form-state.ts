/** State a form receives back from `useActionState`. `values` re-fills the email, never the password. */
export type AuthFormState = {
  status: "idle" | "error" | "check-email";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  values?: { email: string };
  /** Increments on every failed submit so the form can move focus to the error summary again. */
  attempt: number;
};

export const initialAuthState: AuthFormState = { status: "idle", attempt: 0 };
