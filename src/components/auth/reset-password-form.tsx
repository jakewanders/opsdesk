"use client";

import Link from "next/link";
import { useActionState } from "react";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AuthFormState } from "@/lib/auth/form-state";

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
const initial: AuthFormState = { status: "idle", attempt: 0 };
const IDS = { password: "new-password", confirm: "confirm-password" } as const;

/**
 * Choose a new password. Shown only to a signed-in (recovery) session. The two passwords are validated
 * on the server; a failed submit focuses the error summary, and the button is locked while pending.
 */
export function ResetPasswordForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, initial);
  const errors = state.fieldErrors ?? {};

  const summary: ErrorSummaryItem[] = [];
  if (state.message) summary.push({ fieldId: IDS.password, message: state.message });
  if (errors.password?.[0]) summary.push({ fieldId: IDS.password, message: errors.password[0] });
  if (errors.confirm?.[0]) summary.push({ fieldId: IDS.confirm, message: errors.confirm[0] });

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5" aria-busy={pending}>
      <ErrorSummary errors={summary} focusKey={state.attempt} />
      <FormField
        label="New password"
        id={IDS.password}
        error={errors.password?.[0]}
        hint="At least 8 characters."
        required
      >
        {(control) => (
          <Input {...control} name="password" type="password" autoComplete="new-password" />
        )}
      </FormField>
      <FormField label="Repeat new password" id={IDS.confirm} error={errors.confirm?.[0]} required>
        {(control) => (
          <Input {...control} name="confirm" type="password" autoComplete="new-password" />
        )}
      </FormField>
      <Button type="submit" disabled={pending} className="h-10">
        {pending ? "Saving…" : "Save new password"}
      </Button>
      <p className="text-sm text-muted-foreground">
        Saving signs you out on your other devices.{" "}
        <Link href="/login" className="underline underline-offset-2">
          Cancel
        </Link>
      </p>
    </form>
  );
}
