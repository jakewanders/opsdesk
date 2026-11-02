import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDto } from "@/features/tasks/schema";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { DashboardDto } from "../service";
import { DashboardView } from "./dashboard-view";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
// the real chart needs layout jsdom cannot do; it is covered in stage-chart.test.tsx and in the browser (e2e)
vi.mock("./stage-chart-impl", () => ({ default: () => <p>chart drawn</p> }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = "2026-11-02T15:30:00.000000+00:00";
const dashboard = (over: Partial<DashboardDto> = {}): DashboardDto => ({
  basis: "current_state",
  generatedAt: "2026-11-02T15:30:00.000Z",
  today: "2026-11-02",
  timeZone: "UTC",
  activeCustomers: 15,
  openOpportunities: 7,
  pipelineCents: 123_456_789,
  weightedPipelineCents: 61_000_050,
  overdueTasks: 3,
  tasksDueNext7Days: 9,
  opportunitiesByStage: {
    new: { count: 2, amountCents: 1 },
    qualified: { count: 2, amountCents: 1 },
    proposal: { count: 2, amountCents: 1 },
    negotiation: { count: 1, amountCents: 1 },
    won: { count: 2, amountCents: 1 },
    lost: { count: 1, amountCents: 1 },
  },
  recentActivity: [],
  ...over,
});
const task = (id: string, title: string, dueDate: string, dueState: TaskDto["dueState"]): TaskDto =>
  ({
    id,
    title,
    description: null,
    status: "todo",
    priority: "high",
    dueDate,
    dueState,
    dueToday: dueDate === "2026-11-02",
    assignedTo: null,
    customerId: null,
    customerName: null,
    opportunityId: null,
    opportunityTitle: null,
    completedAt: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  }) as TaskDto;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let dash: DashboardDto;
let overdueTasks: TaskDto[];
let soonTasks: TaskDto[];
let dashFail: Response | null;
let calls: Array<{ path: string; method: string; query: URLSearchParams; body?: unknown }>;
function install() {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      path: url.pathname,
      method,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (url.pathname.endsWith("/members")) return json(200, { data: [], meta: {} });
    if (url.pathname.endsWith("/dashboard")) return dashFail ?? json(200, { data: dash, meta: {} });
    if (method === "POST" && url.pathname.endsWith("/complete")) {
      const id = url.pathname.split("/").at(-2)!;
      overdueTasks = overdueTasks.filter((t) => t.id !== id);
      soonTasks = soonTasks.filter((t) => t.id !== id);
      dash = { ...dash, overdueTasks: dash.overdueTasks - 1 };
      return json(200, { data: task(id, "x", "2026-10-30", "done"), meta: {} });
    }
    if (url.pathname.endsWith("/tasks")) {
      const list = url.searchParams.get("overdue") === "true" ? overdueTasks : soonTasks;
      return json(200, {
        data: list,
        meta: { page: 1, limit: 5, total: list.length, totalPages: 1 },
      });
    }
    return json(200, { data: [], meta: {} });
  });
}
const view = (over: Partial<React.ComponentProps<typeof DashboardView>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <DashboardView canWrite currentUserId="u1" timeZone="UTC" {...over} />
    </ApiClientProvider>,
  );

beforeEach(() => {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  dash = dashboard();
  overdueTasks = [task("t1", "Send revised quote", "2026-10-30", "overdue")];
  soonTasks = [
    task("t2", "Book crew", "2026-11-03", "due_soon"),
    task("t3", "Renewal", "2026-11-02", "due_soon"),
  ];
  dashFail = null;
  notify.error.mockClear();
  notify.success.mockClear();
  install();
});
afterEach(() => vi.restoreAllMocks());

describe("DashboardView [SIT-255]", () => {
  it("shows the six KPIs exactly as the API returned them, each a link to its list with a clear name", async () => {
    const { container } = view();
    const links = await screen.findAllByRole("link", { name: /Active customers/ });
    expect(links[0]).toHaveAttribute("href", "/app/customers");
    const expected: Array<[RegExp, string, string]> = [
      [/^Active customers\s*15/, "/app/customers", "15"],
      [/^Open opportunities\s*7/, "/app/opportunities", "7"],
      [/^Pipeline\s*\$1,234,568/, "/app/opportunities?view=list", "$1,234,568"],
      [/^Weighted pipeline\s*\$610,001/, "/app/opportunities", "$610,001"],
      [/^Overdue tasks\s*3\s*needs attention\s*View overdue tasks/, "/app/tasks?overdue=true", "3"],
      [/^Due in the next 7 days\s*9/, "/app/tasks?soon=true", "9"],
    ];
    for (const [name, href] of expected) {
      expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
    }
    // the exact money is available on hover and to assistive tech through the title
    expect(screen.getByRole("link", { name: /^Pipeline/ })).toHaveAttribute(
      "title",
      "$1,234,567.89",
    );
    // overdue is flagged in words, not colour alone
    expect(
      screen.getByRole("link", { name: /Overdue tasks\s*3\s*needs attention/ }),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("no fabricated trends: no percent change, arrows or sparklines", async () => {
    view();
    await screen.findByRole("region", { name: "Key numbers" });
    expect(screen.queryByText(/%|vs\.? last|trend/i)).toBeNull();
    expect(document.querySelector("svg[class*='recharts'], canvas")).toBeNull();
  });

  it("is labelled as current state with a full timestamp", async () => {
    view();
    await screen.findByRole("region", { name: "Key numbers" });
    const time = document.querySelector('time[datetime="2026-11-02T15:30:00.000Z"]')!;
    expect(time).toHaveTextContent("Nov 2, 2026");
    expect(screen.getByText(/Where things stand now/)).toBeInTheDocument();
  });

  it("task widgets list overdue and upcoming tasks with relative day labels and the real date", async () => {
    view();
    const overdue = await screen.findByRole("region", { name: "Overdue" });
    expect(within(overdue).getByText("Send revised quote")).toBeInTheDocument();
    expect(within(overdue).getAllByText("Overdue")).toHaveLength(2); // the heading and the badge
    expect(within(overdue).getByText("3 days ago")).toBeInTheDocument();
    const time = within(overdue).getByText("Oct 30, 2026").closest("time")!;
    expect(time).toHaveAttribute("title", "Friday, October 30, 2026");
    const soon = screen.getByRole("region", { name: "Due in the next 7 days" });
    expect(within(soon).getByText("Tomorrow")).toBeInTheDocument();
    expect(within(soon).getByText("Today")).toBeInTheDocument();
    expect(within(overdue).getByRole("link", { name: /See all/ })).toHaveAttribute(
      "href",
      "/app/tasks?overdue=true",
    );
    expect(within(soon).getByRole("link", { name: /See all/ })).toHaveAttribute(
      "href",
      "/app/tasks?soon=true",
    );
    expect(
      calls.find((c) => c.path.endsWith("/tasks") && c.query.get("dueSoon") === "true"),
    ).toBeTruthy();
  });

  it("quick complete sends the version, removes the task from the list and refetches the dashboard numbers", async () => {
    const user = userEvent.setup();
    view();
    await screen.findByText("Send revised quote");
    await user.click(screen.getByRole("button", { name: "Mark Send revised quote complete" }));
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Task completed", "Send revised quote"),
    );
    expect(calls.find((c) => c.method === "POST")!.body).toMatchObject({
      completed: true,
      expectedUpdatedAt: NOW,
    });
    await waitFor(() => expect(screen.queryByText("Send revised quote")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /^Overdue tasks\s*2/ })).toBeInTheDocument(),
    );
  });

  it("quick actions: add customer / opportunity link to their forms; Add task opens the task form", async () => {
    const user = userEvent.setup();
    view();
    const nav = await screen.findByRole("navigation", { name: "Quick actions" });
    expect(within(nav).getByRole("link", { name: /Add customer/ })).toHaveAttribute(
      "href",
      "/app/customers/new",
    );
    expect(within(nav).getByRole("link", { name: /Add opportunity/ })).toHaveAttribute(
      "href",
      "/app/opportunities/new",
    );
    await user.click(within(nav).getByRole("button", { name: /Add task/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("a viewer sees the numbers but no quick actions and no complete buttons", async () => {
    view({ canWrite: false });
    await screen.findByText("Send revised quote");
    expect(screen.queryByRole("navigation", { name: "Quick actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /complete/ })).toBeNull();
    expect(screen.getByRole("link", { name: /^Active customers/ })).toBeInTheDocument();
  });

  it("a brand-new workspace gets 'Add your first customer' (a viewer gets the explanation without the button)", async () => {
    dash = dashboard({
      activeCustomers: 0,
      openOpportunities: 0,
      pipelineCents: 0,
      weightedPipelineCents: 0,
      overdueTasks: 0,
      tasksDueNext7Days: 0,
      opportunitiesByStage: Object.fromEntries(
        ["new", "qualified", "proposal", "negotiation", "won", "lost"].map((s) => [
          s,
          { count: 0, amountCents: 0 },
        ]),
      ) as DashboardDto["opportunitiesByStage"],
    });
    const first = view();
    expect(
      await screen.findByRole("heading", { name: "Add your first customer" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Add customer/ }).length).toBeGreaterThan(0);
    first.unmount();
    view({ canWrite: false });
    await screen.findByRole("heading", { name: "Add your first customer" });
    expect(screen.queryByRole("link", { name: /Add customer/ })).toBeNull();
  });

  it("shows a loading status first, then an error with the request id and a retry that recovers", async () => {
    dashFail = json(404, { error: { code: "NOT_FOUND", message: "Nope", requestId: "req-42" } });
    const user = userEvent.setup();
    view();
    expect(screen.getByRole("status")).toHaveTextContent("Loading the dashboard");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The dashboard could not be loaded");
    expect(alert).toHaveTextContent("req-42");
    dashFail = null;
    await user.click(within(alert).getByRole("button", { name: /Try again|Retry/ }));
    expect(await screen.findByRole("region", { name: "Key numbers" })).toBeInTheDocument();
  });

  it("the task widget has its own empty state when nothing is overdue or due this week", async () => {
    overdueTasks = [];
    soonTasks = [];
    view();
    expect(await screen.findByText("Nothing overdue or due this week")).toBeInTheDocument();
  });
});
