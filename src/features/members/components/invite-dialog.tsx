"use client";

import { Check, Copy } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorAlert } from "@/components/shared/error-alert";
import { FormField } from "@/components/shared/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { ROLE_HELP, ROLE_LABELS, type Role } from "../member-rules";

type Created = {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  token: string;
  link: string;
};

const INVITE_ROLES: Role[] = ["admin", "member", "viewer"];
const SELECT =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring";
const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * Invite someone by address. Delivery is not part of v1, so on success the dialog shows the one-time link to copy and
 * send yourself. The link exists only in this response: the server stores a hash and cannot show it again, and the dialog
 * says so before the person closes it.
 */
export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<"yes" | "no" | "failed">("no");

  const invite = useApiMutation<Created, { email: string; role: Role }>({
    mutationFn: (vars, { call }) => call<Created>("/invitations", { method: "POST", json: vars }),
    invalidate: [["invitations"]],
  });

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // drop the link from memory when the dialog closes
      setCreated(null);
      setEmail("");
      setRole("member");
      setFieldError(undefined);
      setCopied("no");
      invite.reset();
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(address)) {
      setFieldError("Enter a valid email address.");
      return;
    }
    setFieldError(undefined);
    try {
      const res = await invite.mutateAsync({ email: address, role });
      setCreated(res.data);
    } catch {
      /* shown from invite.error */
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.link);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  const error = invite.error;
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invitation ready</DialogTitle>
              <DialogDescription>
                Send this link to {created.email}. They need to sign in or create an account with
                that address to join as {ROLE_LABELS[created.role as Role].toLowerCase()}.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <p
                role="note"
                className="rounded-md border border-border bg-muted/60 px-3 py-2 text-sm font-medium"
              >
                This link will not be shown again. Copy it now.
              </p>
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label="Invite link"
                  value={created.link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button type="button" onClick={copy} className="shrink-0">
                  {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  Copy invite link
                </Button>
              </div>
              <p role="status" className="min-h-5 text-sm text-muted-foreground">
                {copied === "yes" ? "Link copied." : null}
                {copied === "failed"
                  ? "Your browser blocked copying. Select the link above and copy it."
                  : null}
              </p>
              <p className="text-sm text-muted-foreground">
                The link works once and expires on{" "}
                <time dateTime={created.expiresAt}>{DAY.format(new Date(created.expiresAt))}</time>.
                You can withdraw it any time from Pending invitations.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite someone</DialogTitle>
              <DialogDescription>
                They join with the role you choose. You get a link to send them; no email is sent
                from here.
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <ErrorAlert
                title="Could not create the invitation"
                message={error.message}
                requestId={isClientApiError(error) ? error.requestId : undefined}
              />
            ) : null}
            <FormField label="Email address" error={fieldError} required>
              {(control) => (
                <Input
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  {...control}
                />
              )}
            </FormField>
            <FormField label="Role" hint={ROLE_HELP[role]}>
              {(control) => (
                <select
                  className={SELECT}
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                  {...control}
                >
                  {INVITE_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" pending={invite.isPending}>
                Create invite link
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
