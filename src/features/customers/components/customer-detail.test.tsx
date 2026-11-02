import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityEventDto } from "@/features/activity/repository";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { CustomerDetailDto } from "../schema";
import { CustomerDetail } from "./customer-detail";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  usePathname: () => "/app/customers/x",
  useSearchParams: () => new URLSearchParams(),
}));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const TOM = "00000000-0000-4000-8000-0000000000bb";
const NOW = "2026-11-02T15:30:00.000000+00:00";
const customer = (over: Partial<CustomerDetailDto> = {}): CustomerDetailDto => ({
  id: "11111111-1111-4111-8111-111111111111",
  type: "company",
  displayName: "Acme Plumbing",
  companyName: "Acme Group",
  email: "info@acme.example.com",
  phone: "(202) 555-0100",
  website: "https://acme.example.com",
  status: "active",
  source: "referral",
  tags: ["vip", "north"],
  notes: "Line one\n<script>alert(1)</script>",
  assignedTo: TOM,
  createdBy: ME,
  createdAt: "2026-10-01T12:00:00Z",
  updatedAt: NOW,
  archivedAt: null,
  related: { opportunities: 3, tasks: 2, quotes: 0, openOpportunities: 0, openTasks: 0 },
  ...over,
});
const events: ActivityEventDto[] = [
  {
    id: "e3",
    action: "updated",
    summary: 'Tom Teammate updated customer "Acme Plumbing" (status, notes)',
    actorUserId: TOM,
    createdAt: "2026-11-02T14:00:00Z",
    changes: [{ field: "status", old: "lead", new: "active" }],
    contentChanged: ["notes"],
  },
  {
    id: "e2",
    action: "archived",
    summary: 'You archived customer "Acme Plumbing"',
    actorUserId: ME,
    createdAt: "2026-11-01T14:00:00Z",
    changes: [],
    contentChanged: [],
  },
  {
    id: "e1",
    action: "created",
    summary: 'System created customer "Acme Plumbing"',
    actorUserId: null,
    createdAt: "2026-10-01T12:00:00Z",
    changes: [],
    contentChanged: [],
  },
];
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
let calls: Array<{ url: string; method: string }>;
function installApi(handler?: (url: URL, init: RequestInit) => Response | undefined) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push({ url: url.pathname, method: init?.method ?? "GET" });
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [
          { userId: ME, role: "owner", displayName: "Olivia Owner" },
          { userId: TOM, role: "member", displayName: "Tom Teammate" },
        ],
        meta: {},
      });
    return handler?.(url, init ?? {}) ?? json(200, { data: [], meta: {} });
  });
}
const renderDetail = (over: Partial<React.ComponentProps<typeof CustomerDetail>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <CustomerDetail
        customer={customer()}
        events={events}
        canWrite
        currentUserId={ME}
        timeZone="America/New_York"
        {...over}
      />
    </ApiClientProvider>,
  );

beforeEach(() => {
  refresh.mockClear();
  notify.error.mockClear();
  notify.success.mockClear();
  installApi();
});
afterEach(() => vi.restoreAllMocks());

describe("CustomerDetail [SIT-226]", () => {
  it("header: name with its type for screen readers, company, status as icon and word, owner by name, tags, times in the organization's zone", async () => {
    renderDetail();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Acme Plumbing (company)");
    expect(screen.getByText("Acme Group")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Owner:/)).toHaveTextContent("Owner: Tom Teammate"),
    );
    expect(
      within(screen.getByRole("list", { name: "Tags" }))
        .getAllByRole("listitem")
        .map((l) => l.textContent),
    ).toEqual(["vip", "north"]);
    const created = screen.getByText(/Created/).querySelector("time")!;
    expect(created).toHaveAttribute("datetime", "2026-10-01T12:00:00Z");
    expect(created).toHaveTextContent("Oct 1, 2026, 8:00 AM"); // 12:00Z in New York
  });
  it("overview: contact details, source, counts, a safe website link, and notes as text (the script is not markup)", () => {
    const { container } = renderDetail();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveTextContent("info@acme.example.com");
    expect(panel).toHaveTextContent("(202) 555-0100");
    expect(panel).toHaveTextContent("SourceReferral");
    const link = within(panel).getByRole("link", { name: "https://acme.example.com" });
    expect(link).toHaveAttribute("href", "https://acme.example.com");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(panel).toHaveTextContent("Opportunities3");
    expect(panel).toHaveTextContent("Tasks2");
  });
  it("empty fields say Not set; no notes says No notes", () => {
    renderDetail({
      customer: customer({
        email: null,
        phone: null,
        website: null,
        notes: null,
        tags: [],
        companyName: null,
      }),
    });
    expect(screen.getAllByText("Not set")).toHaveLength(3);
    expect(screen.getByText("No notes.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Tags" })).toBeNull();
  });
  it("tabs have proper roles and are keyboard operable: arrow keys move between Overview and Activity", async () => {
    renderDetail();
    expect(screen.getByRole("tablist", { name: "Customer sections" })).toBeInTheDocument();
    const [overview, activity] = screen.getAllByRole("tab");
    expect(overview).toHaveAttribute("aria-selected", "true");
    overview.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(activity).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(activity).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Activity");
  });
  it("activity: each event shows what happened, who did it (name, You, System) and when, with field changes and edited-field names but never content", async () => {
    renderDetail();
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    const items = Array.from(
      screen.getByRole("list", { name: "Activity" }).children,
    ) as HTMLElement[]; // the top-level events only
    expect(items).toHaveLength(3);
    await waitFor(() => expect(items[0]).toHaveTextContent("By Tom Teammate"));
    expect(items[0]).toHaveTextContent("Updated");
    expect(items[0]).toHaveTextContent("status: lead to active");
    expect(items[0]).toHaveTextContent("notes was edited");
    expect(items[1]).toHaveTextContent("By You");
    expect(items[1]).toHaveTextContent("Archived");
    expect(items[2]).toHaveTextContent("By System");
    expect(items[2]).toHaveTextContent("Created");
    expect(items[0].querySelector("time")).toHaveAttribute("datetime", "2026-11-02T14:00:00Z");
  });
  it("no activity: says so", async () => {
    renderDetail({ events: [] });
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      screen.getByText("No activity has been recorded for this customer yet."),
    ).toBeInTheDocument();
  });
  it("a writer sees Edit and Archive; a viewer sees no Edit and a disabled Archive with the reason", () => {
    const { unmount } = renderDetail();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      "/app/customers/11111111-1111-4111-8111-111111111111/edit",
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument();
    unmount();
    renderDetail({ canWrite: false });
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    const archive = screen.getByRole("button", { name: "Archive" });
    expect(archive).toBeDisabled();
    expect(archive).toHaveAccessibleDescription(/can view this customer but not archive it/);
    expect(screen.getByRole("link", { name: "Back to customers" })).toBeInTheDocument();
  });
  it("archiving asks first (Cancel changes nothing), then DELETEs, says so, refreshes the page's data and the list queries", async () => {
    installApi((url, init) => (init.method === "DELETE" ? json(204, null) : undefined));
    renderDetail();
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Acme Plumbing");
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Archive customer",
      }),
    );
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Customer archived", "Acme Plumbing"),
    );
    expect(calls.find((c) => c.method === "DELETE")!.url).toBe(
      "/api/v1/customers/11111111-1111-4111-8111-111111111111",
    );
    expect(refresh).toHaveBeenCalled();
  });
  it("an archived customer says Archived with a Restore action (no Edit or Archive); Restore POSTs, says so and refreshes", async () => {
    installApi((url, init) =>
      init.method === "POST" ? json(200, { data: customer(), meta: {} }) : undefined,
    );
    renderDetail({ customer: customer({ archivedAt: "2026-11-01T14:00:00Z" }) });
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent("This customer is archived.");
    expect(screen.getByRole("status")).toHaveTextContent("you can restore it");
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Customer restored", "Acme Plumbing"),
    );
    expect(calls.find((c) => c.method === "POST")!.url).toBe(
      "/api/v1/customers/11111111-1111-4111-8111-111111111111/restore",
    );
    expect(refresh).toHaveBeenCalled();
  });
  it("a viewer of an archived customer sees the state but no Restore", () => {
    renderDetail({ customer: customer({ archivedAt: "2026-11-01T14:00:00Z" }), canWrite: false });
    expect(screen.getByRole("status")).toHaveTextContent("This customer is archived.");
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
  it("a refused restore shows the API's message and does not claim success", async () => {
    installApi((url, init) =>
      init.method === "POST"
        ? json(403, {
            error: { code: "DEMO_EXPIRED", message: "This demo has ended.", requestId: "r" },
          })
        : undefined,
    );
    renderDetail({ customer: customer({ archivedAt: "2026-11-01T14:00:00Z" }) });
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This demo has ended.");
    expect(notify.success).not.toHaveBeenCalled();
  });
  it("has no axe violations (overview, activity tab, archived)", async () => {
    const { container } = renderDetail();
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    await expectNoA11yViolations(container);
  });
  it("has no axe violations when archived", async () => {
    const { container } = renderDetail({
      customer: customer({ archivedAt: "2026-11-01T14:00:00Z" }),
    });
    await expectNoA11yViolations(container);
  });
});
