"use client";

import { AuthApiError } from "@supabase/supabase-js";
import { IDEMPOTENCY_HEADER } from "@/lib/api/idempotency-header";
import { createClient } from "@/lib/supabase/client";
import { DemoEntry, type DemoEntryDeps, type DemoStepResult } from "./demo-entry";

/** The real dependencies: Supabase Auth in the browser and the bootstrap endpoint. */
const deps: DemoEntryDeps = {
  async hasSession() {
    try {
      const { data } = await createClient().auth.getUser();
      return Boolean(data.user?.is_anonymous);
    } catch {
      return false;
    }
  },
  async signIn(captchaToken): Promise<DemoStepResult> {
    try {
      const { error } = await createClient().auth.signInAnonymously({ options: { captchaToken } });
      if (!error) return { ok: true };
      return {
        ok: false,
        status: error.status,
        code: error instanceof AuthApiError ? error.code : undefined,
        network: error.name === "AuthRetryableFetchError",
      };
    } catch {
      return { ok: false, network: true };
    }
  },
  async bootstrap(idempotencyKey): Promise<DemoStepResult> {
    try {
      const response = await fetch("/api/v1/demo/bootstrap", {
        method: "POST",
        headers: { [IDEMPOTENCY_HEADER]: idempotencyKey },
      });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; requestId?: string };
      } | null;
      return {
        ok: false,
        status: response.status,
        code: body?.error?.code,
        requestId: body?.error?.requestId,
      };
    } catch {
      return { ok: false, network: true };
    }
  },
  navigate: (path) => window.location.assign(path),
};

export function DemoEntryClient(props: { siteKey: string | undefined; repoUrl?: string }) {
  return <DemoEntry {...props} deps={deps} />;
}
