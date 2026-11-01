import "server-only";
import { getPublicEnv } from "@/lib/env/public";
import { getServerEnv } from "@/lib/env/server";
import { computeTrustedOrigins } from "./request-guard";

/** Origins allowed to send mutations, from validated env (never from request headers). */
export function getTrustedOrigins(): string[] {
  const server = getServerEnv();
  return computeTrustedOrigins({
    appUrl: getPublicEnv().NEXT_PUBLIC_APP_URL,
    context: server.CONTEXT,
    deployPrimeUrl: server.DEPLOY_PRIME_URL,
  });
}
