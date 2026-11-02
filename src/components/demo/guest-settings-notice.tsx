import Link from "next/link";
import { Lock } from "lucide-react";
import { GUEST_LIMITS } from "./guest-limits";

/**
 * Shown at the top of every settings page for a demo guest. Settings are read-only in the demo except Reset Demo (in
 * the banner), and each thing a guest cannot do has its reason next to it, so nothing is just missing.
 */
export function GuestSettingsNotice() {
  return (
    <section
      aria-labelledby="guest-settings-title"
      className="mb-6 rounded-lg border border-border bg-muted/50 p-4 text-sm"
    >
      <h2 id="guest-settings-title" className="flex items-center gap-2 font-semibold">
        <Lock aria-hidden="true" className="size-4" />
        Settings are read-only in the demo
      </h2>
      <p className="mt-1 text-muted-foreground">
        You can look around, and reset the demo from the banner above. These are not available to
        guests:
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {GUEST_LIMITS.map((limit) => (
          <li key={limit.feature}>
            <span className="font-medium">{limit.feature}.</span>{" "}
            <span className="text-muted-foreground">{limit.reason}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3">
        <Link href="/signup" className="font-medium underline underline-offset-4">
          Create an account
        </Link>{" "}
        <span className="text-muted-foreground">to unlock them. A new account starts empty.</span>
      </p>
    </section>
  );
}
