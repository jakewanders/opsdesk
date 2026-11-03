import { unstable_isUnrecognizedActionError as nextIsUnrecognizedActionError } from "next/navigation";

/**
 * A Server Action id belongs to one build. When the site is deployed while a form is open, submitting it calls an action the new server
 * has never heard of, and Next.js throws `UnrecognizedActionError` in the browser (no server digest, so no reference). The page is simply
 * out of date: the right answer is to say so and ask for a reload, not to show a crash.
 */
export function isStaleActionError(error: unknown): boolean {
  if (nextIsUnrecognizedActionError(error)) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.name === "UnrecognizedActionError" ||
    /Failed to find Server Action|Server Action .* was not found/i.test(error.message)
  );
}

export const STALE_ACTION_MESSAGE =
  "OpsDesk was updated while this page was open, so this form is out of date. Reload the page and try again. Nothing was saved.";

type FormState = { status: string; attempt: number; message?: string };

/**
 * Wraps a form's Server Action so a stale-page error becomes an ordinary form error with the reload advice. Any other error is rethrown
 * untouched (the error boundary handles it). A redirect from the action is not an error here: Next.js handles it itself.
 */
export function guardStaleAction<S extends FormState>(
  action: (state: S, formData: FormData) => Promise<S>,
): (state: S, formData: FormData) => Promise<S> {
  return async (state, formData) => {
    try {
      return await action(state, formData);
    } catch (error) {
      if (isStaleActionError(error)) {
        return {
          ...state,
          status: "error",
          attempt: state.attempt + 1,
          message: STALE_ACTION_MESSAGE,
        };
      }
      throw error;
    }
  };
}
