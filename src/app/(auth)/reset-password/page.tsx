import type { Metadata } from "next";
import Link from "next/link";
import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { resetPasswordAction } from "@/lib/auth/actions";
import { getCurrentUser } from "@/lib/supabase/current-user";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  // The recovery link signs the visitor in (via /auth/callback). Without a session there is nothing to reset.
  const user = await getCurrentUser();
  if (!user || user.isAnonymous) {
    return (
      <AuthFormShell title="This reset link has expired">
        <div role="status" className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-5">
          <p>Reset links work once and expire after an hour. Request a new one to continue.</p>
          <p>
            <Link href="/forgot-password" className="font-medium underline underline-offset-2">
              Request a new link
            </Link>
          </p>
        </div>
      </AuthFormShell>
    );
  }
  return (
    <AuthFormShell
      title="Choose a new password"
      intro={`Signed in as ${user.email ?? "your account"}.`}
    >
      <ResetPasswordForm action={resetPasswordAction} />
    </AuthFormShell>
  );
}
