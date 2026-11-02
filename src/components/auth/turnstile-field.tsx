"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { cn } from "@/lib/utils";

type TurnstileApi = {
  render: (
    el: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme?: "light" | "dark" | "auto";
      appearance?: "always" | "execute" | "interaction-only";
    },
  ) => string;
  reset: (widgetId?: string) => void;
  remove: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("no api"));
    script.onerror = () => {
      scriptPromise = undefined;
      reject(new Error("blocked"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

type TurnstileFieldProps = {
  /** Public site key. When missing the form cannot be submitted and says why. */
  siteKey: string | undefined;
  /** Change this after a failed submit: a token works once, so the widget must issue a new one. */
  resetKey: number;
  /** Validation message for the CAPTCHA, shown under the widget. */
  error?: string;
  id?: string;
  /** Called with each new token (and with "" when it expires or errors). */
  onToken?: (token: string) => void;
  /** Called when the widget itself fails (blocked, network, misconfigured key). */
  onError?: () => void;
  /** `interaction-only` shows the widget only if the visitor has to do something (the invisible mode). */
  appearance?: "always" | "interaction-only";
};

/**
 * Cloudflare Turnstile. Supabase checks a token on every public auth call (sign-up, sign-in,
 * password reset, anonymous sign-in), so the forms carry one in the hidden `captchaToken` field.
 * The widget iframe is titled by Cloudflare; the container is a labelled region so the check
 * is announced.
 */
export function TurnstileField({
  siteKey,
  resetKey,
  error,
  id,
  onToken,
  onError,
  appearance = "always",
}: TurnstileFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  const container = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | undefined>(undefined);
  const [token, setToken] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const onTokenRef = useRef(onToken);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onTokenRef.current = onToken;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current || widgetId.current) return;
        widgetId.current = api.render(container.current, {
          sitekey: siteKey,
          theme: "auto",
          appearance,
          callback: (value) => {
            setToken(value);
            onTokenRef.current?.(value);
          },
          "expired-callback": () => {
            setToken("");
            onTokenRef.current?.("");
          },
          "error-callback": () => {
            setToken("");
            onTokenRef.current?.("");
            onErrorRef.current?.();
          },
        });
      })
      .catch(() => {
        setLoadFailed(true);
        onErrorRef.current?.();
      });
    return () => {
      cancelled = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = undefined;
    };
  }, [siteKey, appearance]);

  useEffect(() => {
    if (resetKey === 0 || !widgetId.current) return;
    setToken("");
    window.turnstile?.reset(widgetId.current);
  }, [resetKey]);

  if (!siteKey) {
    return (
      <ErrorAlert
        title="Sign-in check is not set up"
        message="This environment has no bot check configured, so the form cannot be submitted. Set NEXT_PUBLIC_TURNSTILE_SITE_KEY."
      />
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div
        id={fieldId}
        ref={container}
        tabIndex={-1}
        role="group"
        aria-label="Security check"
        className={cn(
          "outline-none focus-visible:ring-3 focus-visible:ring-ring",
          appearance === "always" && "min-h-[65px]",
        )}
      />
      <input type="hidden" name="captchaToken" value={token} />
      {loadFailed ? (
        <p className="text-sm font-medium text-destructive" role="alert">
          The security check could not load. Turn off content blockers for this site and reload.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm font-medium text-destructive">
          <span className="sr-only">Error:</span> {error}
        </p>
      ) : null}
    </div>
  );
}
