/** State the workspace setup form receives back from `useActionState`. */
export type WorkspaceFormState = {
  status: "idle" | "error";
  message?: string;
  fieldErrors?: Record<string, string[]>;
  values?: { name: string; industry: string; timezone: string };
  /** True when a guest tried to create a real workspace: show the "create an account" message, not the form errors. */
  guest?: boolean;
  /** Increments on every failed submit so focus moves to the error summary again. */
  attempt: number;
};
