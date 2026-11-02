/**
 * Availability of the two halves of the product, reported separately (PRD 8.3): the web app answering this request
 * proves `web`; `database` is a no-data probe (`public.health_ping()`) with a short timeout. The answer is only ever
 * "ok" or "unavailable": no error text, host name or key can appear in it.
 */
export type HealthStatus = { web: "ok"; database: "ok" | "unavailable" };

export type HealthDeps = {
  supabaseUrl: string | undefined;
  publishableKey: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export async function checkDatabase(deps: HealthDeps): Promise<"ok" | "unavailable"> {
  const { supabaseUrl, publishableKey, timeoutMs = 2500, fetch: doFetch = fetch } = deps;
  if (!supabaseUrl || !publishableKey) return "unavailable";
  try {
    const response = await doFetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/rpc/health_ping`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${publishableKey}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return "unavailable";
    return (await response.json()) === true ? "ok" : "unavailable";
  } catch {
    return "unavailable"; // refused, DNS, timeout, paused project, garbage: all the same answer
  }
}

export async function checkHealth(deps: HealthDeps): Promise<HealthStatus> {
  return { web: "ok", database: await checkDatabase(deps) };
}
