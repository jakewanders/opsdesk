"use client";

import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { FormField } from "@/components/shared/form-field";
import { notify } from "@/components/shared/toast";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { ROLE_HELP, ROLE_LABELS, type Role } from "../member-rules";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";

type Target = { userId: string; displayName: string; role: string };

/**
 * Change one person's role. Only roles the actor may assign are offered; the API still refuses the rest, and its message
 * (for example the last-owner rule) is shown here in words.
 */
export function ChangeRoleDialog({
  target,
  roles,
  onClose,
}: {
  target: Target | null;
  roles: Role[];
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target ? (
          // keyed so each person starts from a fresh form
          <RoleForm key={target.userId} target={target} roles={roles} onClose={onClose} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RoleForm({
  target,
  roles,
  onClose,
}: {
  target: Target;
  roles: Role[];
  onClose: () => void;
}) {
  const [role, setRole] = useState<Role>(roles[0]);
  const change = useApiMutation<{ userId: string; role: string }, Role>({
    mutationFn: (next, { call }) =>
      call(`/members/${target.userId}`, { method: "PATCH", json: { role: next } }),
    invalidate: [["members"], ["invitations"]],
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await change.mutateAsync(role);
      notify.success(
        "Role changed",
        `${target.displayName} is now ${ROLE_LABELS[role].toLowerCase()}.`,
      );
      onClose();
    } catch {
      /* shown from change.error */
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Change role for {target.displayName}</DialogTitle>
        <DialogDescription>
          Currently {ROLE_LABELS[target.role as Role].toLowerCase()}. The change takes effect
          immediately.
        </DialogDescription>
      </DialogHeader>
      {change.error ? (
        <ErrorAlert
          title="Could not change the role"
          message={change.error.message}
          requestId={isClientApiError(change.error) ? change.error.requestId : undefined}
        />
      ) : null}
      <FormField label="New role" hint={ROLE_HELP[role]}>
        {(control) => (
          <select
            className={SELECT}
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            {...control}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? "Saving..." : "Change role"}
        </Button>
      </DialogFooter>
    </form>
  );
}
