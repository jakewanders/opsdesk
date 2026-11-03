"use client";

import { useSyncExternalStore } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { linkProblemFromHash } from "@/lib/auth/link-problem";

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The notice shown when an e-mail link failed. It reads the URL fragment in the browser to say why (used, expired), else shows the fallback. */
export function LinkProblemNotice({ fallback }: { fallback: string }) {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  const { title, message } = linkProblemFromHash(hash, fallback);
  return <ErrorAlert title={title} message={message} />;
}
