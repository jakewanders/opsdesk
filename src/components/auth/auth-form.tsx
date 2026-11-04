"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AuthFormState } from "@/lib/auth/form-state";
import { guardStaleAction } from "@/lib/auth/stale-action";
import { LinkProblemNotice } from "./link-problem-notice";
import { TurnstileField } from "./turnstile-field";

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;

const initial: AuthFormState = { status: "idle", attempt: 0 };

type AuthFormProps = {
  mode: "login" | "signup" | "forgot";
  action: Action;
  siteKey: string | undefined;
  /** Already-validated post-login path, forwarded as a hidden field. */
  next?: string;
  /** A notice from the previous step, for example an expired link. */
  notice?: string;
  hint?: ReactNode;
};

const IDS = { email: "email", password: "password", captcha: "captcha" } as const;

/**
 * One form for sign-in, sign-up and the password-reset request (email only). Submitting runs a server action that validates with Zod and
 * talks to Supabase Auth; the page never sees the password after the request. While the action is
 * pending the button is disabled, which prevents a double submit. A failed submit puts focus on the
 * error summary and re-issues the CAPTCHA token (a token can be used once).
 */
export function AuthForm({ mode, action, siteKey, next, notice }: AuthFormProps) {
  const [state, formAction, pending] = useActionState(guardStaleAction(action), initial);
  const fieldErrors = state.fieldErrors ?? {};
  const errorFor = (name: string) => fieldErrors[name]?.[0];

  const summary: ErrorSummaryItem[] = [];
  for (const [name, fieldId] of [
    ["email", IDS.email],
    ["password", IDS.password],
    ["captchaToken", IDS.captcha],
  ] as const) {
    const message = errorFor(name);
    if (message) summary.push({ fieldId, message });
  }
  if (state.message) summary.unshift({ fieldId: IDS.email, message: state.message });

  const isSignup = mode === "signup";
  const isForgot = mode === "forgot";

  if (state.status === "check-email") {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-5">
        <h2 className="text-lg font-semibold">Check your email</h2>
        {isForgot ? (
          <p>
            If an account exists for <strong className="break-all">{state.values?.email}</strong>,
            we sent a link to choose a new password. It works once and expires after an hour.
          </p>
        ) : (
          <p>
            If <strong className="break-all">{state.values?.email}</strong> can be used to create an
            account, we sent a confirmation link. Open it to finish signing up, then sign in.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Nothing arrived after a few minutes? Check spam, or{" "}
          <Link href="/login" className="underline underline-offset-2">
            sign in
          </Link>{" "}
          if you already have an account.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5" aria-busy={pending}>
      {notice ? <LinkProblemNotice fallback={notice} /> : null}
      <ErrorSummary errors={summary} focusKey={state.attempt} />
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <FormField label="Email" id={IDS.email} error={errorFor("email")} required>
        {(control) => (
          <Input
            {...control}
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            defaultValue={state.values?.email}
            // The key re-applies the saved value after a failed submit without clearing what was typed.
            key={`email-${state.attempt}`}
          />
        )}
      </FormField>

      {isForgot ? null : (
        <FormField
          label="Password"
          id={IDS.password}
          error={errorFor("password")}
          hint={isSignup ? "At least 8 characters." : undefined}
          required
        >
          {(control) => (
            <Input
              {...control}
              name="password"
              type="password"
              autoComplete={isSignup ? "new-password" : "current-password"}
            />
          )}
        </FormField>
      )}

      <TurnstileField
        siteKey={siteKey}
        resetKey={state.attempt}
        id={IDS.captcha}
        error={errorFor("captchaToken")}
      />

      {pending ? (
        <span role="status" className="sr-only">
          {isForgot ? "Sending…" : isSignup ? "Creating account…" : "Signing in…"}
        </span>
      ) : null}
      <Button type="submit" pending={pending} disabled={!siteKey} className="h-10">
        {isForgot ? "Send reset link" : isSignup ? "Create account" : "Sign in"}
      </Button>

      {isSignup ? (
        <p className="text-sm text-muted-foreground">
          By creating an account you agree to the{" "}
          <Link href="/terms" className="underline underline-offset-2">
            Terms
          </Link>{" "}
          and the{" "}
          <Link href="/privacy" className="underline underline-offset-2">
            Privacy notice
          </Link>
          .
        </p>
      ) : isForgot ? (
        <p className="text-sm">
          <Link href="/login" className="underline underline-offset-2">
            Back to sign in
          </Link>
        </p>
      ) : (
        <p className="text-sm">
          <Link href="/forgot-password" className="touch-link underline underline-offset-2">
            Forgot your password?
          </Link>
        </p>
      )}
    </form>
  );
}
