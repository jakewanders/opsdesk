"use client";

import { Lock } from "lucide-react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Whether the signed-in visitor is a demo guest. UI gating only: the API and the database stay authoritative. */
const GuestContext = createContext(false);

export function GuestModeProvider({
  isGuest,
  children,
}: {
  isGuest: boolean;
  children: ReactNode;
}) {
  return <GuestContext.Provider value={isGuest}>{children}</GuestContext.Provider>;
}
export function useIsGuest(): boolean {
  return useContext(GuestContext);
}

type RestrictedActionProps = {
  /** The control's own label, for example "Invite member". */
  label: string;
  /** Why a guest cannot do it, in plain words. Always visible: a tooltip alone would hide it from keyboards. */
  reason: string;
  className?: string;
};

/**
 * A control a demo guest cannot use. It stays in the page (never silently missing), stays focusable, says it is
 * unavailable (`aria-disabled`) and points at its reason (`aria-describedby`), and the reason is visible text. A real
 * `disabled` attribute would drop it from the tab order and from screen reader navigation, so it is not used.
 */
export function RestrictedAction({ label, reason, className }: RestrictedActionProps) {
  const reasonId = useId();
  return (
    <div className={cn("flex flex-col items-start gap-1", className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-disabled="true"
        aria-describedby={reasonId}
        className="cursor-not-allowed opacity-70"
        onClick={(event) => event.preventDefault()}
      >
        <Lock aria-hidden="true" />
        {label}
      </Button>
      <p id={reasonId} className="text-xs text-muted-foreground">
        {reason}
      </p>
    </div>
  );
}

/**
 * Gate for a feature guests may not use: members see `children`, guests see the explained, inert control. Put every
 * restricted control (invite members, billing, integrations, external e-mail, file uploads, creating a real
 * workspace) behind this so a guest never meets a control that silently does nothing.
 */
export function GuestRestricted({
  label,
  reason,
  children,
  className,
}: RestrictedActionProps & { children: ReactNode }) {
  const isGuest = useIsGuest();
  return isGuest ? (
    <RestrictedAction label={label} reason={reason} className={className} />
  ) : (
    <>{children}</>
  );
}
