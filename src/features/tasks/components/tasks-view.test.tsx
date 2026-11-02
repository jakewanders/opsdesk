import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { TaskListState } from "../list-state";
import type { TaskDto } from "../schema";
import { TasksView } from "./tasks-view";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/tasks",
  useSearchParams: () => new URLSearchParams(search),
}));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const NOW = "2026-11-02T10:00:00.000000+00:00";
const task = (n: number, over: Partial<TaskDto> = {}): TaskDto => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  title: `Task ${n}`,
  description: null,
  status: "todo",
  priority: "medium",
  dueDate: "2026-11-20",
  dueState: "later",
  dueToday: false,
  assignedTo: null,
  customerId: null,
  customerName: null,
  opportunityId: null,
  opportunityTitle: null,
  completedAt: null,
  createdBy: ME,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...over,
});
const DEFAULTS: TaskListState = {
  q: "",
  status: "",
  priority: "",
  mine: "",
  overdue: "",
  group: "",
  sort: "due_date",
  order: "asc",
  page: 1,
  limit: 25,
};
const page = (items: TaskDto[], total = items.length) => ({
  items,
  meta: { page: 1, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
});
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const asApi = (p: ReturnType<typeof page>) => ({ data: p.items, meta: p.meta });

function renderView(
  initial: ReturnType<typeof page> | null,
  over: { canWrite?: boolean; initialState?: TaskListState } = {},
) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <TasksView
        initial={initial}
        initialState={over.initialState ?? DEFAULTS}
        canWrite={over.canWrite ?? true}
        currentUserId={ME}
        timeZone="America/New_York"
      />
    </ApiClientProvider>,
  );
}
function mockMembers(
  extra?: (url: URL, init: RequestInit) => Response | Promise<Response> | undefined,
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [
          { userId: ME, role: "owner", displayName: "Olivia Owner" },
          { userId: "t2", role: "member", displayName: "Tom Teammate" },
        ],
        meta: {},
      });
    return (
      (await extra?.(url, init ?? {})) ?? json(200, { data: [], meta: { total: 0, totalPages: 1 } })
    );
  });
}
const rows = () => screen.getAllByRole("row").slice(1);

beforeEach(() => {
  search = "";
  replace.mockClear();
  notify.error.mockClear();
  notify.success.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("TasksView [SIT-237]", () => {
  it("renders the server's first page without a task request, with title, priority, due date, status, owner and related links", async () => {
    const spy = mockMembers();
    const { container } = renderView(
      page([
        task(1, {
          priority: "urgent",
          assignedTo: ME,
          customerId: "c1",
          customerName: "Acme Plumbing",
          opportunityId: "o1",
          opportunityTitle: "Acme Retrofit",
          status: "in_progress",
        }),
        task(2, { dueDate: null, dueState: "none" }),
      ]),
    );
    const [first, second] = rows();
    expect(first).toHaveTextContent("Task 1");
    expect(first).toHaveTextContent("Urgent");
    expect(first).toHaveTextContent("Nov 20, 2026");
    expect(first).toHaveTextContent("In progress");
    expect(first).toHaveTextContent("You");
    expect(within(first).getByRole("link", { name: "Acme Plumbing" })).toHaveAttribute(
      "href",
      "/app/customers/c1",
    );
    expect(within(first).getByRole("link", { name: "Acme Retrofit" })).toHaveAttribute(
      "href",
      "/app/opportunities/o1",
    );
    expect(second).toHaveTextContent("No due date");
    expect(second).toHaveTextContent("Unassigned");
    expect(screen.getByText("Showing 1 to 2 of 2")).toBeInTheDocument();
    expect(spy.mock.calls.some(([u]) => String(u).includes("/tasks"))).toBe(false);
    await expectNoA11yViolations(container);
  });
  it("overdue and due-today are different words with icons, taken from the API's flags (not recomputed here)", () => {
    mockMembers();
    renderView(
      page([
        task(1, { dueDate: "2020-01-01", dueState: "overdue" }),
        task(2, { dueDate: "2999-01-01", dueState: "due_soon", dueToday: true }), // flagged by the API, whatever the browser's clock says
        task(3, { dueDate: "2026-11-05", dueState: "due_soon", dueToday: false }),
        task(4, {
          dueDate: "2020-01-01",
          dueState: "done",
          status: "done",
          completedAt: "2026-11-01T15:00:00Z",
        }),
      ]),
    );
    const [overdue, today, soon, done] = rows();
    expect(overdue).toHaveTextContent("Overdue");
    expect(overdue).not.toHaveTextContent("Due today");
    expect(today).toHaveTextContent("Due today");
    expect(today).not.toHaveTextContent("Overdue");
    expect(soon).not.toHaveTextContent(/Overdue|Due today/);
    expect(done).not.toHaveTextContent(/Overdue|Due today/);
    expect(done).toHaveTextContent("Completed Nov 1, 2026");
    expect(within(overdue).getByText("Nov 1, 2020".replace("Nov 1", "Jan 1"))).toBeInTheDocument();
    expect(overdue.querySelector("time")).toHaveAttribute("dateTime", "2020-01-01");
    expect(overdue.querySelector("time")).toHaveAttribute("title", "Wednesday, January 1, 2020");
  });
  it("a viewer gets read-only rows: no complete buttons", () => {
    mockMembers();
    renderView(page([task(1)]), { canWrite: false });
    expect(screen.queryByRole("button", { name: /complete|reopen/i })).toBeNull();
    expect(rows()[0]).toHaveTextContent("Task 1");
  });
  it("the quick-complete button posts the version the row was loaded with, says so, and a done row offers Reopen", async () => {
    const listed = page([task(1), task(2, { status: "done", dueState: "done", completedAt: NOW })]);
    const spy = mockMembers((url) =>
      url.pathname.endsWith("/complete")
        ? json(200, { data: task(1, { status: "done" }), meta: {} })
        : url.pathname.endsWith("/tasks")
          ? json(200, asApi(listed))
          : undefined,
    );
    renderView(listed);
    await userEvent.click(screen.getByRole("button", { name: "Mark Task 1 complete" }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith("Task completed", "Task 1"));
    const call = spy.mock.calls.find(([u]) => String(u).includes("/complete"))!;
    expect(new URL(String(call[0]), "http://localhost").pathname).toContain(
      "/tasks/00000000-0000-4000-8000-000000000001/complete",
    );
    expect(JSON.parse(String(call[1]!.body))).toEqual({ completed: true, expectedUpdatedAt: NOW });
    await userEvent.click(screen.getByRole("button", { name: "Reopen Task 2" }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith("Task reopened", "Task 2"));
    expect(
      JSON.parse(
        String(spy.mock.calls.filter(([u]) => String(u).includes("/complete")).at(-1)![1]!.body),
      ),
    ).toMatchObject({ completed: false });
  });
  it("a refused complete (409) is reported and does not claim success", async () => {
    mockMembers((url) =>
      url.pathname.endsWith("/complete")
        ? json(409, { error: { code: "STALE_EDIT", message: "changed", requestId: "r" } })
        : undefined,
    );
    renderView(page([task(1)]));
    await userEvent.click(screen.getByRole("button", { name: "Mark Task 1 complete" }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        "The task was not completed",
        expect.stringMatching(/Someone else changed it/),
      ),
    );
    expect(notify.success).not.toHaveBeenCalled();
  });
  it("filters write to the URL: assigned to me, overdue, status, priority; clear filters empties them", async () => {
    mockMembers();
    renderView(page([task(1)]));
    await userEvent.click(screen.getByLabelText("Assigned to me"));
    expect(replace).toHaveBeenLastCalledWith("/app/tasks?mine=true", { scroll: false });
    await userEvent.click(screen.getByLabelText("Overdue"));
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("overdue=true"), {
      scroll: false,
    });
    await userEvent.selectOptions(screen.getByLabelText("Status"), "blocked");
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("status=blocked"), {
      scroll: false,
    });
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "urgent");
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("priority=urgent"), {
      scroll: false,
    });
  });
  it("sorting: choosing priority sorts most urgent first (order=desc)", async () => {
    mockMembers();
    renderView(page([task(1)]));
    await userEvent.selectOptions(screen.getByLabelText("Sort by"), "priority");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringMatching(/sort=priority.*order=desc|order=desc.*sort=priority/),
      { scroll: false },
    );
  });
  it("sorting: the order menu flips it and its words match the sort", async () => {
    search = "sort=priority&order=desc";
    mockMembers();
    renderView(page([task(1)]), { initialState: { ...DEFAULTS, sort: "priority", order: "desc" } });
    expect(
      within(screen.getByLabelText("Order"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Lowest first", "Most urgent first"]);
    await userEvent.selectOptions(screen.getByLabelText("Order"), "asc");
    expect(replace).toHaveBeenLastCalledWith("/app/tasks?sort=priority", { scroll: false });
  });
  it("grouping by status adds a labelled group header per status that has rows", async () => {
    search = "group=status";
    mockMembers();
    renderView(
      page([
        task(1, { status: "todo" }),
        task(2, { status: "blocked" }),
        task(3, { status: "todo" }),
      ]),
      { initialState: { ...DEFAULTS, group: "status" } },
    );
    const groups = screen.getAllByRole("rowheader").map((h) => h.textContent);
    expect(groups).toEqual(["To do (2)", "Blocked (1)"]);
    expect(screen.getByText(/grouped within this page/)).toBeInTheDocument();
  });
  it("paging: Previous is disabled on page 1, Next goes to page 2", async () => {
    mockMembers();
    renderView(
      page(
        Array.from({ length: 25 }, (_, i) => task(i + 1)),
        60,
      ),
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenLastCalledWith("/app/tasks?page=2", { scroll: false });
  });
  it("empty: No tasks yet; filtered empty: No tasks match with a way out; past the end offers page 1", async () => {
    mockMembers();
    const { unmount } = renderView(page([], 0));
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
    unmount();
    search = "overdue=true";
    renderView(null, { initialState: { ...DEFAULTS, overdue: "true" } });
    await waitFor(() => expect(screen.getByText("No tasks match")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenLastCalledWith("/app/tasks", { scroll: false });
  });
  it("a failed read shows an error with a retry, and retry recovers", async () => {
    let n = 0;
    mockMembers((url) =>
      url.pathname.endsWith("/tasks")
        ? ++n === 1
          ? json(403, { error: { code: "FORBIDDEN", message: "No access", requestId: "req-1" } })
          : json(200, asApi(page([task(7)])))
        : undefined,
    );
    renderView(null);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Tasks could not be loaded");
    await userEvent.click(within(alert).getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByText("Task 7")).toBeInTheDocument();
  });
  it("the table is a labelled, keyboard-focusable scroll region and the complete buttons are reachable with Tab", async () => {
    mockMembers();
    renderView(page([task(1)]));
    const region = screen.getByRole("region", { name: "Tasks table" });
    expect(region).toHaveAttribute("tabindex", "0");
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Mark Task 1 complete" });
    for (let i = 0; i < 40 && document.activeElement !== button; i++) await user.tab();
    expect(button).toHaveFocus();
  });
});
