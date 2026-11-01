import type { Metadata } from "next";
import { connection } from "next/server";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { forgotPasswordAction } from "@/lib/auth/actions";
import { getPublicEnv } from "@/lib/env/public";

export const metadata: Metadata = { title: "Reset your password" };

export default async function ForgotPasswordPage() {
  // Reads runtime configuration (the Turnstile site key), so it must render per request, not at build.
  await connection();
  return (
    <AuthFormShell
      title="Reset your password"
      intro="Enter the email for your account and we will send a link to choose a new password."
    >
      <AuthForm
        mode="forgot"
        action={forgotPasswordAction}
        siteKey={getPublicEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY}
      />
    </AuthFormShell>
  );
}
