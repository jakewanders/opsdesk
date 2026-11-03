import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import type { TaskListState } from "../list-state";
import type { TaskDto } from "../schema";
import { TasksView } from "./tasks-view";

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
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
  dueDate: "2020-01-01",
  dueState: "overdue",
  dueToday: false,
  assignedTo: null,
  customerId: null,
  customerName: null,
  customerArchived: false,
  opportunityId: null,
  opportunityTitle: null,
  opportunityArchived: false,
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
  customerId: "",
  opportunityId: "",
  overdue: "",
  soon: "",
  group: "",
  sort: "due_date",
  order: "asc",
  page: 1,
  limit: 25,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let tasks: TaskDto[];
let posts: Array<Record<string, unknown>>;
let failNext: { status: number; error: Record<string, unknown> } | null;
let hangReads: boolean;

function installApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members")) return json(200, { data: [], meta: {} });
    if (init?.method === "POST" && url.pathname.endsWith("/complete")) {
      const id = url.pathname.split("/").at(-2)!;
      const body = JSON.parse(String(init.body));
      posts.push({ id, ...body });
      if (failNext) {
        const f = failNext;
        failNext = null;
        hangReads = true;
        return json(f.status, { error: { requestId: "r1", ...f.error } });
      }
      tasks = tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              status: body.completed ? "done" : "todo",
              completedAt: body.completed ? NOW : null,
              dueState: body.completed ? "done" : "overdue",
              updatedAt: "2026-11-02T11:00:00.000000+00:00",
            }
          : t,
      );
      return json(200, { data: tasks.find((t) => t.id === id), meta: {} });
    }
    if (hangReads) return new Promise<Response>(() => undefined);
    const overdue = url.searchParams.get("overdue") === "true";
    const list = tasks.filter((t) => !overdue || t.dueState === "overdue");
    return json(200, {
      data: list,
      meta: { page: 1, limit: 25, total: list.length, totalPages: 1 },
    });
  });
}
const initialFor = (list: TaskDto[]) => ({
  items: list,
  meta: { page: 1, limit: 25, total: list.length, totalPages: 1 },
});
function renderView(state: TaskListState = DEFAULTS) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <TasksView
        initial={initialFor(
          tasks.filter((t) => state.overdue !== "true" || t.dueState === "overdue"),
        )}
        initialState={state}
        canWrite
        currentUserId={ME}
        timeZone="America/New_York"
      />
    </ApiClientProvider>,
  );
}
function expectSame(now: string, original: string) {
  if (now === original) return;
  let i = 0;
  while (original[i] === now[i]) i++;
  throw new Error(
    `table differs at ${i}: expected ...${original.slice(Math.max(0, i - 60), i + 100)}... got ...${now.slice(Math.max(0, i - 60), i + 100)}...`,
  );
}
const rows = () => screen.getAllByRole("row").slice(1);

beforeEach(() => {
  search = "";
  tasks = [task(1), task(2), task(3, { dueDate: "2999-01-01", dueState: "later" })];
  posts = [];
  failNext = null;
  hangReads = false;
  notify.error.mockClear();
  notify.success.mockClear();
  installApi();
});
afterEach(() => vi.restoreAllMocks());

describe("one-click complete: optimistic update and exact rollback [SIT-242]", () => {
  it("completing removes the task from Overdue and lowers the counts immediately, then keeps the server's answer", async () => {
    search = "overdue=true";
    renderView({ ...DEFAULTS, overdue: "true" });
    expect(screen.getByText("Showing 1 to 2 of 2")).toBeInTheDocument();
    hangReads = false;
    await userEvent.click(screen.getByRole("button", { name: "Mark Task 1 complete" }));
    // immediately, before the server has answered anything about the list
    expect(screen.queryByText("Task 1")).toBeNull();
    expect(screen.getByText("Showing 1 to 1 of 1")).toBeInTheDocument();
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith("Task completed", "Task 1"));
    expect(posts[0]).toEqual({ id: tasks[0].id, completed: true, expectedUpdatedAt: NOW });
    await waitFor(() => expect(screen.getByText("Showing 1 to 1 of 1")).toBeInTheDocument());
    expect(rows()).toHaveLength(1);
  });
  it("in the full list the row becomes Done at once: struck-through, no Overdue mark, a completion line", async () => {
    renderView();
    const before = rows()[0].textContent;
    expect(before).toContain("Overdue");
    await userEvent.click(screen.getByRole("button", { name: "Mark Task 1 complete" }));
    const row = rows()[0];
    expect(row).toHaveTextContent("Done");
    expect(row).toHaveTextContent(/Completed /);
    expect(row).not.toHaveTextContent("Overdue");
    expect(within(row).getByRole("button", { name: "Reopen Task 1" })).toBeInTheDocument();
  });
  it("reopening a done task puts the due marks back from the shared rules", async () => {
    tasks = [task(1, { status: "done", dueState: "done", completedAt: NOW })];
    renderView();
    await userEvent.click(screen.getByRole("button", { name: "Reopen Task 1" }));
    const row = rows()[0];
    expect(row).toHaveTextContent("To do");
    expect(row).toHaveTextContent("Overdue"); // due 2020-01-01
    expect(row).not.toHaveTextContent("Completed");
  });
  it.each([
    [
      409,
      { code: "STALE_EDIT", message: "changed", meta: { current: { updatedAt: "x" } } },
      /Someone else changed it/,
    ],
    [403, { code: "FORBIDDEN", message: "no" }, /permission/],
    [500, { code: "INTERNAL_ERROR", message: "Something broke" }, /Something broke/],
  ])(
    "a failed complete (%s) restores the original row and counts EXACTLY, and says why",
    async (status, error, message) => {
      search = "overdue=true";
      renderView({ ...DEFAULTS, overdue: "true" });
      const original = document.querySelector("table")!.outerHTML;
      const counts = screen.getByText("Showing 1 to 2 of 2").textContent;
      failNext = { status, error };
      await userEvent.click(screen.getByRole("button", { name: "Mark Task 1 complete" }));
      await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
      expect(notify.error.mock.calls[0][0]).toBe("The task was not completed");
      expect(notify.error.mock.calls[0][1]).toMatch(message);
      // reads are held back, so only the rollback itself can have restored the list
      await waitFor(() => expect(screen.getByText("Task 1")).toBeInTheDocument());
      expect(screen.getByText("Showing 1 to 2 of 2").textContent).toBe(counts);
      expectSame(document.querySelector("table")!.outerHTML, original);
      expect(notify.success).not.toHaveBeenCalled();
    },
  );
  it("a failed reopen also restores the done row exactly", async () => {
    tasks = [task(1, { status: "done", dueState: "done", completedAt: NOW })];
    renderView();
    const original = document.querySelector("table")!.outerHTML;
    failNext = { status: 500, error: { code: "INTERNAL_ERROR", message: "Boom" } };
    await userEvent.click(screen.getByRole("button", { name: "Reopen Task 1" }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith("The task was not reopened", expect.anything()),
    );
    await waitFor(() => expect(document.querySelector("table")!.outerHTML).toBe(original));
  });
});
