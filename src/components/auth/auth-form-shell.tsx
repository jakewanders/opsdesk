import type { ReactNode } from "react";

/** Heading + intro + body used by every auth screen, so they read and space the same way. */
export function AuthFormShell({
  title,
  intro,
  children,
  footer,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {intro ? <p className="text-muted-foreground">{intro}</p> : null}
      </header>
      {children}
      {footer ? <div className="text-sm text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
