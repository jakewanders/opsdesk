"use client";

import { LogOut, Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { DemoResetButton } from "@/components/demo/demo-reset-button";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/shared/error-summary";
import { FormField } from "@/components/shared/form-field";
import { notify } from "@/components/shared/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApi, useClearApiCache } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { logoutAction } from "@/lib/auth/actions";
import { useUnsavedChangesGuard } from "@/lib/use-unsaved-changes-guard";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { ROLE_LABELS, type Role } from "@/features/members/member-rules";
import {
  FIELD_ORDER,
  settingsResolver,
  toFormValues,
  toPayload,
  type SettingsFormValues,
} from "../form-values";
import type { OrganizationSettingsDto } from "../schema";

const LABELS: Record<(typeof FIELD_ORDER)[number], string> = {
  name: "Workspace name",
  industry: "Industry",
  timezone: "Time zone",
};
const fieldId = (name: string) => `org-${name}`;
const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring aria-invalid:border-destructive";

type Props = {
  settings: OrganizationSettingsDto;
  memberRole: Role;
  /** Demo workspaces are a guest's own and read-only here, except Reset Demo. */
  isDemo: boolean;
  /** Owner and admin of a real workspace (the permission matrix decides; the API and database enforce it). */
  canEdit: boolean;
  zones: string[];
};

/**
 * /app/settings/organization (PRD 9.8): the workspace's name, industry and time zone. Owners and admins edit; everyone else sees the
 * same values as plain text with the reason they cannot change them. A guest sees the demo's values and Reset Demo. Everyone gets a
 * sign-out button. A time zone change clears the browser's cached data and re-reads the page, so the dashboard and the overdue
 * counts follow the new zone immediately.
 */
export function OrganizationSettings({ settings, memberRole, isDemo, canEdit, zones }: Props) {
  const router = useRouter();
  const { fetch: call } = useApi();
  const clearCache = useClearApiCache();
  const [version, setVersion] = useState(settings.updatedAt);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const form = useForm<SettingsFormValues>({
    resolver: settingsResolver,
    defaultValues: toFormValues(settings),
    mode: "onSubmit",
    reValidateMode: "onChange",
  });
  const { register, handleSubmit, setError, reset, formState } = form;
  const { errors, isDirty, isSubmitting, submitCount } = formState;
  const guard = useUnsavedChangesGuard(canEdit && isDirty);

  const save = useApiMutation<OrganizationSettingsDto, SettingsFormValues>({
    mutationFn: (values, { call: c }) =>
      c(`/organizations/${settings.id}`, {
        method: "PATCH",
        json: { ...toPayload(values), expectedUpdatedAt: version },
      }),
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setStale(false);
    const zoneChanged = values.timezone !== settings.timezone;
    try {
      const res = await save.mutateAsync(values);
      reset(toFormValues(res.data));
      setVersion(res.data.updatedAt);
      // Dates in every cached list and number depend on the zone; drop them and re-read the server-rendered parts.
      clearCache();
      router.refresh();
      notify.success(
        "Settings saved",
        zoneChanged ? `Dates and overdue counts now follow ${res.data.timezone}.` : res.data.name,
      );
    } catch (error) {
      if (!isClientApiError(error)) {
        setFormError("Something went wrong and the settings were not saved. Try again.");
        return;
      }
      if (error.isStaleEdit) {
        setStale(true);
        return;
      }
      if (error.isValidation && error.fieldErrors) {
        let placed = 0;
        for (const [path, messages] of Object.entries(error.fieldErrors)) {
          const field = path.split(".")[0];
          if ((FIELD_ORDER as readonly string[]).includes(field)) {
            setError(field as keyof SettingsFormValues, { type: "server", message: messages[0] });
            placed++;
          }
        }
        if (placed === 0) setFormError(error.message);
        return;
      }
      setFormError(
        error.status === 403
          ? "Only owners and admins can change these settings."
          : `${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}`,
      );
    }
  });

  const reload = async () => {
    try {
      const latest = await call<OrganizationSettingsDto>(`/organizations/${settings.id}`);
      reset(toFormValues(latest.data));
      setVersion(latest.data.updatedAt);
      setStale(false);
      notify.info("Loaded the latest version", "Your changes were discarded.");
    } catch {
      setFormError("The latest version could not be loaded. Reload the page.");
    }
  };

  const summary: ErrorSummaryItem[] = useMemo(
    () =>
      submitCount === 0
        ? []
        : FIELD_ORDER.flatMap((name) => {
            const message = errors[name]?.message;
            return typeof message === "string"
              ? [{ fieldId: fieldId(name), message: `${LABELS[name]}: ${message}` }]
              : [];
          }),
    [errors, submitCount],
  );
  const err = (name: keyof SettingsFormValues) =>
    typeof errors[name]?.message === "string" ? (errors[name]?.message as string) : undefined;

  const roleLabel = isDemo ? "Guest" : ROLE_LABELS[memberRole];

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Organization settings</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          Your role in this workspace: <Badge variant="secondary">{roleLabel}</Badge>
        </p>
      </header>

      {canEdit ? (
        <form
          noValidate
          onSubmit={onSubmit}
          aria-label="Organization settings"
          className="flex max-w-xl flex-col gap-5"
        >
          <ErrorSummary errors={summary} focusKey={submitCount} />
          {stale ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
            >
              <p className="font-semibold">Someone else changed these settings.</p>
              <p className="mt-1">
                Your changes were not saved. Load the latest version, then make your edit again.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3"
                onClick={() => void reload()}
              >
                Load the latest version
              </Button>
            </div>
          ) : null}
          {formError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive-subtle p-4 text-sm"
            >
              {formError}
            </div>
          ) : null}
          <FormField
            id={fieldId("name")}
            label={LABELS.name}
            required
            error={err("name")}
            hint="2 to 80 characters."
          >
            {(c) => <Input {...c} {...register("name")} autoComplete="organization" />}
          </FormField>
          <FormField
            id={fieldId("industry")}
            label={LABELS.industry}
            error={err("industry")}
            hint="Optional, up to 80 characters."
          >
            {(c) => <Input {...c} {...register("industry")} autoComplete="off" />}
          </FormField>
          <FormField
            id={fieldId("timezone")}
            label={LABELS.timezone}
            required
            error={err("timezone")}
            hint="Decides what counts as today, so it sets which tasks are overdue."
          >
            {(c) => (
              <select {...c} {...register("timezone")} className={SELECT_CLASS}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            )}
          </FormField>
          <div>
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex max-w-xl flex-col gap-5">
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {isDemo
              ? "A demo workspace cannot be renamed or moved to another time zone. Create an account and a workspace of your own to set these."
              : "Only owners and admins can change these settings. Ask one of them if something needs to change."}
          </p>
          <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="font-medium">{LABELS.name}</dt>
            <dd>{settings.name}</dd>
            <dt className="font-medium">{LABELS.industry}</dt>
            <dd>{settings.industry ?? <span className="text-muted-foreground">Not set</span>}</dd>
            <dt className="font-medium">{LABELS.timezone}</dt>
            <dd>{settings.timezone.replace(/_/g, " ")}</dd>
          </dl>
          {isDemo ? (
            <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-muted/50 p-4 text-sm">
              <p className="font-medium">Reset the demo</p>
              <p className="text-muted-foreground">
                Puts the sample data back as it was when you started. Your changes in the demo are
                removed.
              </p>
              <DemoResetButton />
            </div>
          ) : null}
        </div>
      )}

      <section
        aria-labelledby="signout-title"
        className="flex max-w-xl flex-col gap-2 border-t border-border pt-6"
      >
        <h2 id="signout-title" className="text-base font-semibold">
          Sign out
        </h2>
        <p className="text-sm text-muted-foreground">
          {isDemo
            ? "Signing out of a demo ends it for this browser; the next visit starts a fresh demo."
            : "Ends your session on this device. Your workspace and data stay as they are."}
        </p>
        <form action={logoutAction}>
          <Button type="submit" variant="outline">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </form>
      </section>

      <ConfirmDialog
        open={guard.pendingHref !== null}
        onOpenChange={(open) => {
          if (!open) guard.stay();
        }}
        title="Discard your changes?"
        description="You have unsaved changes to these settings. If you leave now they are lost."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => guard.confirmLeave()}
      />
    </div>
  );
}
