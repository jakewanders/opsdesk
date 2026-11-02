"use client";

import { Plus, Users } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorAlert } from "@/components/shared/error-alert";
import { TableSkeleton } from "@/components/shared/skeletons";
import { notify } from "@/components/shared/toast";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import { useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import type { InvitationDto } from "../schema";
import type { MemberDto } from "../service";
import { memberRowRules, ROLE_LABELS, type Role } from "../member-rules";
import { ChangeRoleDialog } from "./change-role-dialog";
import { InviteDialog } from "./invite-dialog";

const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const day = (iso: string) => (
  <time dateTime={iso} title={new Date(iso).toUTCString()}>
    {DAY.format(new Date(iso))}
  </time>
);

type Props = {
  /** The first read, done on the server with the caller's session. Null if it failed (the browser retries). */
  initialMembers: MemberDto[] | null;
  actorId: string;
  actorRole: string;
  /** Owners and admins manage members. Everyone else gets the read-only list. */
  canManage: boolean;
};

const TH = "px-3 py-2 text-left font-medium";
const TD = "px-3 py-2 align-middle";

/**
 * The Members page (PRD 9.8): people with their role and join date, pending invitations with expiry, and the actions the
 * actor may take. Hiding or disabling a control is only presentation (see `memberRowRules`); the API and the database
 * decide, and what they refuse is shown in words.
 */
export function MembersView({ initialMembers, actorId, actorRole, canManage }: Props) {
  const members = useApiQuery<MemberDto[]>(["members"], "/members", {
    initialData: initialMembers ? { data: initialMembers, meta: {} } : undefined,
    staleTime: 0,
  });
  const invitations = useApiQuery<InvitationDto[]>(["invitations"], "/invitations", {
    enabled: canManage,
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleTarget, setRoleTarget] = useState<MemberDto | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberDto | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<InvitationDto | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  const remove = useApiMutation<void, string>({
    mutationFn: (userId, { call }) => call(`/members/${userId}`, { method: "DELETE" }),
    invalidate: [["members"], ["invitations"]],
  });
  const revoke = useApiMutation<void, string>({
    mutationFn: (id, { call }) => call(`/invitations/${id}`, { method: "DELETE" }),
    invalidate: [["invitations"]],
  });

  const list = members.data?.data ?? [];
  const ownerCount = list.filter((m) => m.role === "owner").length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-prose">
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {canManage
              ? "Invite people, change roles, and remove members."
              : "Everyone in this workspace and their role. Only owners and admins can change this list."}
          </p>
        </div>
        {canManage ? (
          <Button type="button" onClick={() => setInviteOpen(true)}>
            <Plus aria-hidden="true" />
            Invite someone
          </Button>
        ) : null}
      </header>

      <section aria-labelledby="members-heading" className="flex flex-col gap-3">
        <h2 id="members-heading" className="text-lg font-semibold">
          People{list.length ? ` (${list.length})` : ""}
        </h2>
        {members.isError ? (
          <ErrorAlert
            title="Members could not be loaded"
            message={members.error.message}
            requestId={isClientApiError(members.error) ? members.error.requestId : undefined}
            onRetry={() => void members.refetch()}
          />
        ) : members.isPending ? (
          <TableSkeleton label="Loading members" columns={4} rows={4} />
        ) : (
          <div ref={tableRef} className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">Members of this workspace</caption>
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th scope="col" className={TH}>
                    Name
                  </th>
                  <th scope="col" className={TH}>
                    Role
                  </th>
                  <th scope="col" className={TH}>
                    Joined
                  </th>
                  <th scope="col" className={TH}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {list.map((m) => {
                  const rules = memberRowRules({
                    actorRole,
                    actorId,
                    target: m,
                    ownerCount,
                  });
                  const isSelf = m.userId === actorId;
                  const canChange = rules.assignableRoles.length > 0;
                  return (
                    <tr key={m.userId}>
                      <th scope="row" className={`${TD} text-left font-medium`}>
                        {m.displayName}
                        {isSelf ? (
                          <Badge variant="secondary" className="ml-2">
                            You
                          </Badge>
                        ) : null}
                      </th>
                      <td className={TD}>{ROLE_LABELS[m.role as Role] ?? m.role}</td>
                      <td className={TD}>{day(m.joinedAt)}</td>
                      <td className={TD}>
                        {canManage ? (
                          <div className="flex flex-wrap items-center gap-2">
                            {canChange ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setRoleTarget(m)}
                              >
                                Change role
                                <span className="sr-only"> for {m.displayName}</span>
                              </Button>
                            ) : null}
                            {rules.canRemove ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setRemoveTarget(m)}
                              >
                                Remove
                                <span className="sr-only"> {m.displayName}</span>
                              </Button>
                            ) : null}
                            {rules.reason ? (
                              <span className="text-xs text-muted-foreground">{rules.reason}</span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Read only</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage ? (
        <section aria-labelledby="invitations-heading" className="flex flex-col gap-3">
          <h2 id="invitations-heading" className="text-lg font-semibold">
            Pending invitations
          </h2>
          {invitations.isError ? (
            <ErrorAlert
              title="Invitations could not be loaded"
              message={invitations.error.message}
              requestId={
                isClientApiError(invitations.error) ? invitations.error.requestId : undefined
              }
              onRetry={() => void invitations.refetch()}
            />
          ) : invitations.isPending ? (
            <TableSkeleton label="Loading invitations" columns={4} rows={2} />
          ) : (invitations.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Users />}
              headingLevel={3}
              title="No pending invitations"
              description="Invite a teammate and the link you copy appears here until they use it or it expires."
              action={
                <Button type="button" variant="outline" onClick={() => setInviteOpen(true)}>
                  Invite someone
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">Invitations that have not been used</caption>
                <thead className="border-b border-border bg-muted/50">
                  <tr>
                    <th scope="col" className={TH}>
                      Email
                    </th>
                    <th scope="col" className={TH}>
                      Role
                    </th>
                    <th scope="col" className={TH}>
                      Expires
                    </th>
                    <th scope="col" className={TH}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invitations.data!.data.map((i) => (
                    <tr key={i.id}>
                      <th scope="row" className={`${TD} text-left font-medium break-all`}>
                        {i.email}
                      </th>
                      <td className={TD}>{ROLE_LABELS[i.role as Role] ?? i.role}</td>
                      <td className={TD}>
                        {i.expired ? (
                          <span className="font-medium text-destructive">
                            Expired {day(i.expiresAt)}
                          </span>
                        ) : (
                          day(i.expiresAt)
                        )}
                      </td>
                      <td className={TD}>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setRevokeTarget(i)}
                        >
                          Revoke
                          <span className="sr-only"> invitation for {i.email}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <ChangeRoleDialog
        target={roleTarget}
        roles={
          roleTarget
            ? memberRowRules({ actorRole, actorId, target: roleTarget, ownerCount }).assignableRoles
            : []
        }
        onClose={() => setRoleTarget(null)}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.displayName ?? "member"}?`}
        description="They lose access to this workspace right away. Their records stay. You can invite them again later."
        confirmLabel="Remove member"
        fallbackFocus={() => tableRef.current?.querySelector("button") ?? null}
        onConfirm={async () => {
          if (!removeTarget) return;
          await remove.mutateAsync(removeTarget.userId);
          notify.success("Member removed", `${removeTarget.displayName} no longer has access.`);
        }}
      />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="Revoke this invitation?"
        description={`The link sent to ${revokeTarget?.email ?? "them"} stops working. You can create a new one.`}
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          if (!revokeTarget) return;
          await revoke.mutateAsync(revokeTarget.id);
          notify.success("Invitation revoked");
        }}
      />
    </div>
  );
}
