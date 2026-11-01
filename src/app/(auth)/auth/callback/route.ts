// Auth callback (SIT-189 implements the code exchange). Until then, a request that arrives
// here is sent to the login page instead of failing. The redirect target is a fixed relative
// path, never derived from the Host header or a query parameter.
export function GET(): Response {
  return new Response(null, { status: 307, headers: { Location: "/login" } });
}
