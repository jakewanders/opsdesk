"use client";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { notify } from "@/components/shared/toast";
import { useApiQuery } from "@/lib/api-client/provider";
import { useApiMutation } from "@/lib/api-client/use-api-mutation";
import { isClientApiError } from "@/lib/api-client/api-fetch";
import type { CustomerDetailDto } from "../schema";

type Props = {
  /** The customer to archive, or null when the dialog is closed. */
  customer: { id: string; displayName: string } | null;
  onClose: () => void;
  /** Runs after the customer was archived (the detail page refreshes its server data here). */
  onArchived?: () => void;
  /** Where focus returns when the control that opened the dialog is gone (see ConfirmDialog). */
  fallbackFocus?: () => HTMLElement | null;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Archive confirmation shared by the list row menu and the detail page. When the customer still has open opportunities or
 * tasks the dialog says how many, and always explains retention. A failure stays in the dialog with the API's message
 * and its request id. Invalidates the list, the customer, and the dashboard.
 */
export function ArchiveCustomerDialog({ customer, onClose, onArchived, fallbackFocus }: Props) {
  const id = customer?.id;
  const detail = useApiQuery<CustomerDetailDto>(
    ["customers", "detail", id ?? "none"],
    `/customers/${id}`,
    {
      enabled: Boolean(id),
    },
  );
  const archive = useApiMutation<undefined, string>({
    mutationFn: (customerId, { call }) => call(`/customers/${customerId}`, { method: "DELETE" }),
    invalidate: [["customers"], ["dashboard"]],
  });
  const related = detail.data?.data.related;
  const open = related ? { opps: related.openOpportunities, tasks: related.openTasks } : null;
  const hasOpen = open !== null && (open.opps > 0 || open.tasks > 0);

  return (
    <ConfirmDialog
      open={customer !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Archive this customer?"
      description={
        <>
          <strong>{customer?.displayName}</strong>
          {hasOpen ? (
            <>
              {" "}
              still has{" "}
              <strong>
                {[
                  open.opps > 0
                    ? plural(open.opps, "open opportunity", "open opportunities")
                    : null,
                  open.tasks > 0 ? plural(open.tasks, "open task", "open tasks") : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}
              </strong>
              . They stay open and visible.{" "}
            </>
          ) : (
            ". "
          )}
          Archiving hides this customer from the active list. Related records and history are kept.
          You can restore it any time.
        </>
      }
      confirmLabel="Archive customer"
      fallbackFocus={fallbackFocus}
      onConfirm={async () => {
        if (!customer) return;
        try {
          await archive.mutateAsync(customer.id);
        } catch (error) {
          // the dialog shows the message; add the request id so it can be quoted
          throw new Error(
            isClientApiError(error) && error.requestId
              ? `${error.message} (request ${error.requestId})`
              : error instanceof Error
                ? error.message
                : "The customer was not archived.",
          );
        }
        notify.success("Customer archived", customer.displayName);
        onArchived?.();
      }}
    />
  );
}
