import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getPublicEnv } from "@/lib/env/public";
import { authCookieOptions } from "./cookie-options";
import type { Database } from "./database.types";
import { resolveUser, type CurrentUser } from "./resolve-user";

/**
 * Routes that read or change the session. Everything else (the static landing and legal pages)
 * is left alone so it stays cacheable and never receives a Set-Cookie header.
 */
export function needsSession(pathname: string): boolean {
  return (
    pathname === "/app" ||
    pathname.startsWith("/app/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/api/") ||
    ["/demo", "/login", "/signup", "/forgot-password", "/reset-password"].includes(pathname)
  );
}

/**
 * Refreshes the Supabase session for a request (called from src/proxy.ts) and forwards any new
 * cookies on the response. The request cookies are updated too, so the page that renders next
 * sees the refreshed session. The library also returns cache headers that must accompany
 * auth cookies; they are copied onto the response so a CDN never caches a Set-Cookie.
 */
export async function updateSession(
  request: NextRequest,
): Promise<{ response: NextResponse; user: CurrentUser | null }> {
  let response = NextResponse.next({ request });
  const env = getPublicEnv();

  const supabase = createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookieOptions: authCookieOptions(),
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Do not run code between creating the client and this call: it performs the refresh.
  const user = await resolveUser(supabase);
  return { response, user };
}
