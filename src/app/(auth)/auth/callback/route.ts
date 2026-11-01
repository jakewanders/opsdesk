import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { getPublicEnv } from "@/lib/env/public";
import { createClient } from "@/lib/supabase/server";

/**
 * Email links (sign-up confirmation) arrive here with a one-time `code`. It is exchanged for a
 * session, then the visitor is sent to a validated in-app path. Redirects are built from the
 * configured app origin, never from the Host header or a query parameter. A missing, reused or
 * expired code sends the visitor to the login page with a notice. (Password recovery uses the same
 * exchange with `next=/app/...`; its screens arrive with SIT-189.)
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Read the request first: that makes this handler dynamic, so the build never runs it (and never
  // needs the Supabase environment variables).
  const code = request.nextUrl.searchParams.get("code");
  const next = request.nextUrl.searchParams.get("next");
  const origin = getPublicEnv().NEXT_PUBLIC_APP_URL;
  const target = (path: string) => NextResponse.redirect(new URL(path, origin), 303);
  if (!code) return target("/login?error=callback");

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return target("/login?error=callback");
  } catch {
    return target("/login?error=callback");
  }
  return target(safeNextPath(next));
}
