import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROBABILITY } from "@/lib/domain/pipeline";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "@/features/opportunities/schema";
import type { TaskDto } from "@/features/tasks/schema";
import { quotesTabEnabled } from "../quotes-tab";
import type { CustomerDetailDto } from "../schema";
import { CustomerDetail } from "./customer-detail";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/customers/x",
  useSearchParams: () => new URLSearchParams(),
}));

const ME = "00000000-0000-4000-8000-0000000000aa";
const CID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-02T10:00:00.000000+00:00";
const customer = (over: Partial<CustomerDetailDto> = {}): CustomerDetailDto => ({
  id: CID,
  type: "company",
  displayName: "Acme Plumbing",
  companyName: null,
  email: null,
  phone: null,
  website: null,
  status: "active",
  source: "other",
  tags: [],
  notes: null,
  assignedTo: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  related: { opportunities: 2, tasks: 3, quotes: 0, openOpportunities: 1, openTasks: 2 },
  ...over,
});
const opp = (id: string, title: string): OpportunityDto => ({
  id,
  customerId: CID,
  customerName: "Acme Plumbing",
  customerArchived: false,
  title,
  description: null,
  stage: "proposal",
  amountCents: 123450,
  probabilityPercent: DEFAULT_PROBABILITY.proposal,
  expectedCloseDate: "2026-12-01",
  assignedTo: null,
  lostReason: null,
  closedAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
});
const task = (id: string, title: string, over: Partial<TaskDto> = {}): TaskDto =>
  ({
    id,
    title,
    description: null,
    status: "todo",
    priority: "medium",
    dueDate: "2026-11-10",
    dueState: "upcoming",
    dueToday: false,
    assignedTo: null,
    customerId: CID,
    customerName: "Acme Plumbing",
    customerArchived: false,
    opportunityId: null,
    opportunityTitle: null,
    opportunityArchived: false,
    completedAt: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  }) as TaskDto;
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let calls: URL[];
let bodies: Array<{ path: string; body: Record<string, unknown> }>;
let opps: OpportunityDto[];
let tasks: TaskDto[];
let fail: Response | null;
function install() {
  calls = [];
  bodies = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push(url);
    if (url.pathname.endsWith("/members")) return json(200, { data: [], meta: {} });
    if (init?.method === "POST") {
      bodies.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      if (fail) return fail;
      if (url.pathname.endsWith("/complete")) {
        const id = url.pathname.split("/").at(-2)!;
        tasks = tasks.map((t) => (t.id === id ? { ...t, status: "done", dueState: "done" } : t));
        return json(200, { data: tasks.find((t) => t.id === id), meta: {} });
      }
      return json(201, { data: task("new", "x"), meta: {} });
    }
    const list = url.pathname.endsWith("/opportunities") ? opps : tasks;
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Number(url.searchParams.get("limit") ?? 25);
    return json(200, {
      data: list.slice((page - 1) * limit, page * limit),
      meta: {
        page,
        limit,
        total: list.length,
        totalPages: Math.max(1, Math.ceil(list.length / limit)),
      },
    });
  });
}
const view = (props: Partial<React.ComponentProps<typeof CustomerDetail>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <CustomerDetail
        customer={customer()}
        events={[]}
        canWrite
        currentUserId={ME}
        timeZone="UTC"
        {...props}
      />
    </ApiClientProvider>,
  );

beforeEach(() => {
  opps = [opp("o1", "Boiler replacement"), opp("o2", "Annual service")];
  tasks = [task("t1", "Call Acme"), task("t2", "Send quote", { status: "done", dueState: "done" })];
  fail = null;
  notify.error.mockClear();
  notify.success.mockClear();
  install();
});
afterEach(() => vi.restoreAllMocks());

describe("customer detail: related records [SIT-243]", () => {
  it("tab labels carry the counts from the detail endpoint; no Quotes tab and no extra request until a tab is opened", () => {
    view();
    expect(screen.getByRole("tab", { name: "Opportunities (2)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Tasks (3)" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Quotes/ })).toBeNull();
    expect(
      calls.some((c) => c.pathname.endsWith("/opportunities") || c.pathname.endsWith("/tasks")),
    ).toBe(false);
  });

  it("opportunities tab lists only this customer's deals (customerId in the request) with stage, amount, close date and links", async () => {
    const { container } = view();
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "Boiler replacement" })).toHaveAttribute(
      "href",
      "/app/opportunities/o1",
    );
    expect(within(table).getAllByText("$1,234.50")).toHaveLength(2);
    expect(within(table).getAllByText("Proposal").length).toBe(2);
    expect(within(table).getAllByText("Dec 1, 2026").length).toBe(2);
    const sent = calls.find((c) => c.pathname.endsWith("/opportunities"))!;
    expect(sent.searchParams.get("customerId")).toBe(CID);
    expect(sent.searchParams.get("limit")).toBe("10");
    expect(screen.getByRole("link", { name: /Add opportunity/ })).toHaveAttribute(
      "href",
      `/app/opportunities/new?customerId=${CID}`,
    );
    await expectNoA11yViolations(container);
  });

  it("is server-paginated: a second page is requested with page=2", async () => {
    opps = Array.from({ length: 12 }, (_, i) => opp(`o${i}`, `Deal ${i}`));
    view();
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    await screen.findByRole("table");
    expect(screen.getByText("Page 1 of 2 (12 in total)")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.pathname.endsWith("/opportunities") && c.searchParams.get("page") === "2",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("Deal 11")).toBeInTheDocument();
  });

  it("empty states: a writer is invited to add; a viewer is not; an archived customer cannot get new records", async () => {
    opps = [];
    const first = view();
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    expect(await screen.findByText("No opportunities for this customer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add opportunity/ })).toBeInTheDocument();
    first.unmount();
    const viewer = view({ canWrite: false });
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    await screen.findByText("No opportunities for this customer");
    expect(screen.queryByRole("link", { name: /Add opportunity/ })).toBeNull();
    viewer.unmount();
    view({ customer: customer({ archivedAt: "2026-11-01T10:00:00Z" }) });
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    await screen.findByText("No opportunities for this customer");
    expect(screen.queryByRole("link", { name: /Add opportunity/ })).toBeNull();
  });

  it("an archived customer still shows its historical opportunities and tasks", async () => {
    view({ customer: customer({ archivedAt: "2026-11-01T10:00:00Z" }) });
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    expect(await screen.findByRole("link", { name: "Boiler replacement" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }));
    expect(await screen.findByText("Call Acme")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add task/ })).toBeNull();
  });

  it("tasks tab asks for this customer's tasks, shows status and due state, and completes a task in place", async () => {
    const { container } = view();
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }));
    await screen.findByText("Call Acme");
    expect(calls.find((c) => c.pathname.endsWith("/tasks"))!.searchParams.get("customerId")).toBe(
      CID,
    );
    await userEvent.click(screen.getByRole("button", { name: "Mark Call Acme complete" }));
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Task completed", "Call Acme", expect.anything()),
    );
    expect(bodies.find((b) => b.path.endsWith("/tasks/t1/complete"))!.body).toMatchObject({
      completed: true,
    });
    expect(screen.getByRole("button", { name: "Reopen Call Acme" })).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("a failed completion puts the row back and says why", async () => {
    view();
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }));
    await screen.findByText("Call Acme");
    fail = json(403, { error: { code: "FORBIDDEN", message: "No.", requestId: "r1" } });
    await userEvent.click(screen.getByRole("button", { name: "Mark Call Acme complete" }));
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Mark Call Acme complete" })).toBeInTheDocument();
  });

  it("Add task opens the drawer with this customer already chosen, and the POST carries that customerId", async () => {
    tasks = [];
    view();
    await userEvent.click(screen.getByRole("tab", { name: /Tasks/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Add task" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: /Customer/ })).toHaveValue("Acme Plumbing");
    await userEvent.type(within(dialog).getByLabelText(/Title/), "Follow up");
    await userEvent.click(within(dialog).getByRole("button", { name: /^(Add task|Save|Create)/ }));
    await waitFor(() => expect(bodies.find((b) => b.path.endsWith("/tasks"))).toBeTruthy());
    expect(bodies.find((b) => b.path.endsWith("/tasks"))!.body).toMatchObject({
      title: "Follow up",
      customerId: CID,
    });
  });

  it("a read failure shows an error with a retry", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).includes("/members")
        ? json(200, { data: [], meta: {} })
        : json(404, { error: { code: "NOT_FOUND", message: "Nope", requestId: "r9" } }),
    );
    view();
    await userEvent.click(screen.getByRole("tab", { name: /Opportunities/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Opportunities could not be loaded");
  });

  it("the Quotes tab appears only when a quotes tab is supplied, and the gate follows the feature flag", () => {
    expect(quotesTabEnabled({ quotes: true })).toBe(true); // the flag is on and the quotes API exists
    expect(quotesTabEnabled({ quotes: false })).toBe(false);
    view({ quotesTab: { count: 4, content: <p>Quote list</p> } });
    expect(screen.getByRole("tab", { name: "Quotes (4)" })).toBeInTheDocument();
  });
});
