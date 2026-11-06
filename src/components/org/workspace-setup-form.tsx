"use client";

import Link from "next/link";
import { useActionState, useId, useState, useSyncExternalStore } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkspaceFormState } from "@/lib/org/form-state";

type Action = (state: WorkspaceFormState, formData: FormData) => Promise<WorkspaceFormState>;
const initial: WorkspaceFormState = { status: "idle", attempt: 0 };
const IDS = {
  name: "workspace-name",
  industry: "workspace-industry",
  timezone: "workspace-timezone",
} as const;

/** Every IANA zone this browser knows, plus UTC; empty where `Intl.supportedValuesOf` is missing (the user can type one). */
let cachedZones: string[] | null = null;
const noSubscription = () => () => undefined;
function knownTimeZones(): string[] {
  cachedZones ??= computeTimeZones();
  return cachedZones;
}
function computeTimeZones(): string[] {
  try {
    const zones =
      (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.(
        "timeZone",
      ) ?? [];
    return ["UTC", ...zones.filter((z) => z !== "UTC")];
  } catch {
    return ["UTC"];
  }
}

function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.includes("/") ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Workspace setup (US-02): name, optional industry, a searchable time zone that defaults to the browser's, and the
 * fixed currency. Field errors come from the same Zod schema as the API (`fieldErrors`); a guest gets the
 * "create an account" message instead of a form error. The button locks while the request is pending.
 */
export function WorkspaceSetupForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, initial);
  const listId = useId();
  // Browser-only values read without an effect: the server (and first hydration pass) sees UTC, the browser its own zone.
  const zones = useSyncExternalStore(noSubscription, knownTimeZones, () => ["UTC"]);
  const detected = useSyncExternalStore(
    noSubscription,
    () => browserTimeZone() ?? "UTC",
    () => "UTC",
  );
  const [typed, setTyped] = useState<string | null>(null);
  const timezone = typed ?? state.values?.timezone ?? detected;

  const errors = state.fieldErrors ?? {};
  const first = (key: string) => errors[key]?.[0];
  const summary: ErrorSummaryItem[] = [];
  if (state.message) summary.push({ fieldId: IDS.name, message: state.message });
  for (const [key, id] of [
    ["name", IDS.name],
    ["industry", IDS.industry],
    ["timezone", IDS.timezone],
  ] as const) {
    if (first(key)) summary.push({ fieldId: id, message: first(key)! });
  }

  if (state.guest) {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-5">
        <h2 className="text-lg font-semibold">Create an account to keep your data</h2>
        <p>
          Guests explore a demo workspace that is deleted after 24 hours, so they cannot create
          their own workspace.
        </p>
        <p className="flex gap-4 text-sm">
          <Link href="/signup" className="font-medium underline underline-offset-2">
            Create an account
          </Link>
          <Link href="/login" className="underline underline-offset-2">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5" aria-busy={pending}>
      {state.status === "error" && !summary.length ? (
        <ErrorAlert message="We could not create the workspace." />
      ) : null}
      <ErrorSummary errors={summary} focusKey={state.attempt} />

      <FormField
        label="Workspace name"
        id={IDS.name}
        error={first("name")}
        hint="2 to 80 characters. Your company or team."
        required
      >
        {(control) => (
          <Input
            {...control}
            name="name"
            autoComplete="organization"
            defaultValue={state.values?.name}
            key={`name-${state.attempt}`}
            maxLength={200}
          />
        )}
      </FormField>

      <FormField
        label="Industry"
        id={IDS.industry}
        error={first("industry")}
        hint="Optional: for example Plumbing or Landscaping."
      >
        {(control) => (
          <Input
            {...control}
            name="industry"
            defaultValue={state.values?.industry}
            key={`industry-${state.attempt}`}
            maxLength={200}
          />
        )}
      </FormField>

      <FormField
        label="Time zone"
        id={IDS.timezone}
        error={first("timezone")}
        hint="Start typing to search, for example America/New_York. Due dates and reports use it."
        required
      >
        {(control) => (
          <>
            <Input
              {...control}
              name="timezone"
              list={listId}
              value={timezone}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id={listId}>
              {zones.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </>
        )}
      </FormField>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Currency</span>
        <p className="text-sm text-muted-foreground">
          US dollars (USD). OpsDesk v1 uses one currency.
        </p>
      </div>

      <Button type="submit" disabled={pending} className="h-10">
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
