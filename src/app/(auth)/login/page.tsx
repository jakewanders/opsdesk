import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { loginAction } from "@/lib/auth/actions";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { getPublicEnv } from "@/lib/env/public";
import { getCurrentUser } from "@/lib/supabase/current-user";

export const metadata: Metadata = { title: "Sign in" };

const NOTICES: Record<string, string> = {
  callback:
    'That link is invalid or has expired. Sign in, or request a new link from "Forgot your password?".',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const destination = safeNextPath(next);
  const user = await getCurrentUser();
  if (user && !user.isAnonymous) redirect(destination);

  return (
    <AuthFormShell
      title="Sign in"
      intro="Use the email and password for your OpsDesk workspace."
      footer={
        <p>
          New here?{" "}
          <Link href="/signup" className="underline underline-offset-2">
            Create an account
          </Link>
          , or{" "}
          <Link href="/demo" className="underline underline-offset-2">
            try the live demo
          </Link>{" "}
          without one.
        </p>
      }
    >
      <AuthForm
        mode="login"
        action={loginAction}
        siteKey={getPublicEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY}
        next={next ? destination : undefined}
        notice={error ? NOTICES[error] : undefined}
      />
    </AuthFormShell>
  );
}
