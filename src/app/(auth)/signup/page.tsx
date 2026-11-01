import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthFormShell } from "@/components/auth/auth-form-shell";
import { signupAction } from "@/lib/auth/actions";
import { getPublicEnv } from "@/lib/env/public";
import { getCurrentUser } from "@/lib/supabase/current-user";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage() {
  const user = await getCurrentUser();
  if (user && !user.isAnonymous) redirect("/app");

  return (
    <AuthFormShell
      title="Create your account"
      intro="Set up a free workspace for your team. We email a link to confirm your address."
      footer={
        <p>
          Already have an account?{" "}
          <Link href="/login" className="underline underline-offset-2">
            Sign in
          </Link>
          .
        </p>
      }
    >
      <AuthForm
        mode="signup"
        action={signupAction}
        siteKey={getPublicEnv().NEXT_PUBLIC_TURNSTILE_SITE_KEY}
      />
    </AuthFormShell>
  );
}
