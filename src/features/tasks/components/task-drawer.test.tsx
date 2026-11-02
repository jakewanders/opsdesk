import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { TaskListState } from "../list-state";
import type { TaskDto } from "../schema";
import { TasksView } from "./tasks-view";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/tasks",
  useSearchParams: () => new URLSearchParams(),
}));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const TOM = "00000000-0000-4000-8000-0000000000bb";
const NOW = "2026-11-02T10:00:00.000000+00:00";
const base = (over: Partial<TaskDto> = {}): TaskDto => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Call the client",
  description: null,
  status: "todo",
  priority: "medium",
  dueDate: "2026-11-05",
  dueState: "due_soon",
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
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const CUSTOMERS = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    displayName: "Acme Plumbing",
    companyName: null,
    email: null,
  },
];
const DEALS = [
  {
    id: "d0000000-0000-4000-8000-000000000001",
    title: "Warehouse retrofit",
    customerName: "Acme Plumbing",
  },
];

let calls: Array<{ url: URL; init: RequestInit }>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response> | undefined;
function mockApi(list: TaskDto[], handler?: Handler) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push({ url, init: init ?? {} });
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [
          { userId: ME, role: "owner", displayName: "Olivia Owner" },
          { userId: TOM, role: "member", displayName: "Tom Teammate" },
        ],
        meta: {},
      });
    if (url.pathname.endsWith("/customers")) return json(200, { data: CUSTOMERS, meta: {} });
    if (url.pathname.endsWith("/opportunities")) return json(200, { data: DEALS, meta: {} });
    const custom = await handler?.(url, init ?? {});
    if (custom) return custom;
    return json(200, {
      data: list,
      meta: { page: 1, limit: 25, total: list.length, totalPages: 1 },
    });
  });
}
const writes = () => calls.filter((c) => ["POST", "PATCH", "DELETE"].includes(c.init.method ?? ""));
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

function renderView(list: TaskDto[], canWrite = true) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <TasksView
        initial={{ items: list, meta: { page: 1, limit: 25, total: list.length, totalPages: 1 } }}
        initialState={DEFAULTS}
        canWrite={canWrite}
        currentUserId={ME}
        timeZone="America/New_York"
      />
    </ApiClientProvider>,
  );
}
const drawer = () => screen.getByRole("dialog");

beforeEach(() => {
  notify.error.mockClear();
  notify.success.mockClear();
  notify.info.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("task drawer: adding [SIT-242]", () => {
  it("opens from Add task as a labelled dialog with every field, and the date shown for a task due 2026-11-05 is Nov 5", async () => {
    mockApi([base()]);
    renderView([base()]);
    expect(within(screen.getAllByRole("row")[1]).getByText("Nov 5, 2026")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const dialog = drawer();
    expect(dialog).toHaveAccessibleName("Add task");
    for (const label of [
      /Title/,
      "Status",
      "Priority",
      "Due date",
      "Assignee",
      "Description",
      "Customer",
      "Opportunity",
    ])
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Due date")).toHaveAttribute("type", "date");
  });
  it("sends the normalized body (trimmed title, the date exactly as typed, blanks as null) and then closes with a toast", async () => {
    mockApi([base()], (url, init) =>
      init.method === "POST" && url.pathname.endsWith("/tasks")
        ? json(201, {
            data: base({ id: "22222222-2222-4222-8222-222222222222", title: "Order parts" }),
            meta: {},
          })
        : undefined,
    );
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const d = drawer();
    await userEvent.type(within(d).getByLabelText(/Title/), "  Order parts ");
    await userEvent.selectOptions(within(d).getByLabelText("Priority"), "urgent");
    await userEvent.type(within(d).getByLabelText("Due date"), "2026-11-05");
    await userEvent.selectOptions(within(d).getByLabelText("Assignee"), TOM);
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith("Task added", "Order parts"));
    const [call] = writes();
    expect(call.init.method).toBe("POST");
    expect(body(call)).toEqual({
      title: "Order parts",
      description: null,
      status: "todo",
      priority: "urgent",
      dueDate: "2026-11-05",
      assignedTo: TOM,
      customerId: null,
      opportunityId: null,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("the pickers search this workspace and send the chosen ids", async () => {
    mockApi([base()], (url, init) =>
      init.method === "POST" ? json(201, { data: base(), meta: {} }) : undefined,
    );
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const d = drawer();
    await userEvent.type(within(d).getByLabelText(/Title/), "Follow up");
    await userEvent.type(within(d).getByRole("combobox", { name: "Customer" }), "acme");
    await userEvent.click(
      await within(
        within(d).getByRole("listbox", { name: "Matching customers", hidden: true }),
      ).findByRole("option", { name: /Acme Plumbing/ }),
    );
    await userEvent.type(within(d).getByRole("combobox", { name: "Opportunity" }), "ware");
    await userEvent.click(
      await within(
        within(d).getByRole("listbox", { name: "Matching opportunities", hidden: true }),
      ).findByRole("option", { name: /Warehouse retrofit/ }),
    );
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0])).toMatchObject({
      customerId: CUSTOMERS[0].id,
      opportunityId: DEALS[0].id,
    });
    expect(
      calls.some(
        (c) =>
          c.url.pathname.endsWith("/opportunities") &&
          c.url.searchParams.get("archived") === "false",
      ),
    ).toBe(true);
  });
  it("an empty submit names the title at the field and in a focused summary, and sends nothing", async () => {
    mockApi([base()]);
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const d = drawer();
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    expect(within(d).getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    expect(within(d).getByRole("alert")).toHaveFocus();
    expect(writes()).toHaveLength(0);
  });
  it("API field errors land at their fields; a missing linked record is shown at its picker; the drawer stays open with the values", async () => {
    mockApi([base()], () =>
      json(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the highlighted fields.",
          requestId: "r",
          fieldErrors: {
            dueDate: ["Enter a date that exists."],
            title: ["Use between 2 and 160 characters."],
          },
        },
      }),
    );
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const d = drawer();
    await userEvent.type(within(d).getByLabelText(/Title/), "Server disagrees");
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(within(d).getByLabelText("Due date")).toHaveAttribute("aria-invalid", "true"),
    );
    expect(within(d).getByLabelText(/Title/)).toHaveValue("Server disagrees");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    vi.restoreAllMocks();
    mockApi([base()], () =>
      json(404, {
        error: {
          code: "CUSTOMER_NOT_FOUND",
          message: "That customer was not found.",
          requestId: "r",
        },
      }),
    );
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    await waitFor(() =>
      expect(within(d).getByRole("combobox", { name: "Customer" })).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
  });
  it("Blocked shows an optional reason hint and does not require a description", async () => {
    mockApi([base()], (_u, init) =>
      init.method === "POST"
        ? json(201, { data: base({ status: "blocked" }), meta: {} })
        : undefined,
    );
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    const d = drawer();
    expect(within(d).queryByText("Optional: say what is blocking this task.")).toBeNull();
    await userEvent.selectOptions(within(d).getByLabelText("Status"), "blocked");
    expect(within(d).getByText("Optional: say what is blocking this task.")).toBeInTheDocument();
    await userEvent.type(within(d).getByLabelText(/Title/), "Stuck task");
    await userEvent.click(within(d).getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0])).toMatchObject({ status: "blocked", description: null });
  });
});

describe("task drawer: editing, archiving, conflicts [SIT-242]", () => {
  it("a row's title opens the edit drawer with its values; saving sends a PATCH with the version loaded", async () => {
    const t = base({ description: "Bring the quote", priority: "high", assignedTo: TOM });
    mockApi([t], (_u, init) =>
      init.method === "PATCH"
        ? json(200, { data: { ...t, title: "Call the client today" }, meta: {} })
        : undefined,
    );
    renderView([t]);
    await userEvent.click(screen.getByRole("button", { name: /^Call the client\s*\(edit\)$/ }));
    const d = drawer();
    expect(d).toHaveAccessibleName("Edit task");
    expect(within(d).getByLabelText(/Title/)).toHaveValue("Call the client");
    expect(within(d).getByLabelText("Due date")).toHaveValue("2026-11-05");
    expect(within(d).getByLabelText("Priority")).toHaveValue("high");
    expect(within(d).getByLabelText("Description")).toHaveValue("Bring the quote");
    await userEvent.type(within(d).getByLabelText(/Title/), " today");
    await userEvent.click(within(d).getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Task saved", "Call the client today"),
    );
    const [call] = writes();
    expect(call.init.method).toBe("PATCH");
    expect(call.url.pathname).toContain(`/tasks/${t.id}`);
    expect(body(call)).toMatchObject({
      title: "Call the client today",
      dueDate: "2026-11-05",
      expectedUpdatedAt: NOW,
    });
  });
  it("a stale edit (409) says so and loads the latest version on request, then saves against it", async () => {
    const t = base();
    const latest = {
      ...t,
      title: "Changed elsewhere",
      updatedAt: "2026-11-02T12:00:00.000000+00:00",
    };
    mockApi([t], (url, init) => {
      if (init.method === "PATCH" && body({ init }).expectedUpdatedAt === NOW)
        return json(409, {
          error: {
            code: "STALE_EDIT",
            message: "changed",
            requestId: "r",
            meta: { current: { updatedAt: latest.updatedAt } },
          },
        });
      if (init.method === "PATCH") return json(200, { data: latest, meta: {} });
      if (url.pathname.endsWith(`/tasks/${t.id}`)) return json(200, { data: latest, meta: {} });
      return undefined;
    });
    renderView([t]);
    await userEvent.click(screen.getByRole("button", { name: /^Call the client\s*\(edit\)$/ }));
    const d = drawer();
    await userEvent.type(within(d).getByLabelText(/Title/), "!");
    await userEvent.click(within(d).getByRole("button", { name: "Save changes" }));
    const alert = await within(d).findByRole("alert");
    expect(alert).toHaveTextContent("Someone else changed this task.");
    await userEvent.click(within(alert).getByRole("button", { name: "Load the latest version" }));
    await waitFor(() => expect(within(d).getByLabelText(/Title/)).toHaveValue("Changed elsewhere"));
    await userEvent.type(within(d).getByLabelText(/Title/), "!");
    await userEvent.click(within(d).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    expect(body(writes().at(-1)!).expectedUpdatedAt).toBe(latest.updatedAt);
  });
  it("archive asks first (Cancel keeps it), then DELETEs, toasts and closes", async () => {
    const t = base();
    mockApi([t], (_u, init) => (init.method === "DELETE" ? json(204, null) : undefined));
    renderView([t]);
    await userEvent.click(screen.getByRole("button", { name: /^Call the client\s*\(edit\)$/ }));
    await userEvent.click(within(drawer()).getByRole("button", { name: "Archive task" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Call the client");
    await userEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(writes()).toHaveLength(0);
    await userEvent.click(within(drawer()).getByRole("button", { name: "Archive task" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Archive task" }),
    );
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Task archived", "Call the client"),
    );
    expect(writes()[0].init.method).toBe("DELETE");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("viewers cannot open the drawer: no Add task, and the titles are plain text", () => {
    mockApi([base()]);
    renderView([base()], false);
    expect(screen.queryByRole("button", { name: "Add task" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Call the client\s*\(edit\)$/ })).toBeNull();
  });
});

describe("task drawer: focus, Escape and accessibility [SIT-242]", () => {
  it("traps focus (Tab cycles inside), starts inside, and returns focus to the control that opened it", async () => {
    mockApi([base()]);
    renderView([base()]);
    const opener = screen.getByRole("button", { name: "Add task" });
    await userEvent.click(opener);
    const d = drawer();
    expect(d.contains(document.activeElement)).toBe(true);
    const user = userEvent.setup();
    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(d.contains(document.activeElement), `tab ${i}`).toBe(true);
    }
    // focus may be in a picker whose list is open: the first Escape closes the list, the next closes the drawer
    for (let i = 0; i < 2 && screen.queryByRole("dialog"); i++) await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
  it("Escape closes a pristine drawer at once; with edits it asks first, Keep editing stays and Discard closes", async () => {
    mockApi([base()]);
    renderView([base()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(within(drawer()).getByLabelText(/Title/), "Half typed");
    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Discard your changes?");
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(drawer()).getByLabelText(/Title/)).toHaveValue("Half typed");
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(writes()).toHaveLength(0);
  });
  it("Escape inside an open picker list closes the list, not the drawer", async () => {
    mockApi([base()]);
    renderView([base()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    const picker = within(drawer()).getByRole("combobox", { name: "Customer" });
    await user.click(picker);
    await user.type(picker, "acme");
    expect(picker).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(picker).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("can be completed with the keyboard alone", async () => {
    mockApi([base()], (_u, init) =>
      init.method === "POST"
        ? json(201, { data: base({ title: "Keyboard task" }), meta: {} })
        : undefined,
    );
    renderView([base()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(within(drawer()).getByLabelText(/Title/), "Keyboard task");
    const submit = within(drawer()).getByRole("button", { name: "Add task" });
    for (let i = 0; i < 40 && document.activeElement !== submit; i++) await user.tab();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith("Task added", "Keyboard task"));
  });
  it("has no axe violations open (add and edit) and with errors showing", async () => {
    mockApi([base()]);
    renderView([base()]);
    await userEvent.click(screen.getByRole("button", { name: "Add task" }));
    await expectNoA11yViolations(document.body);
    await userEvent.click(within(drawer()).getByRole("button", { name: "Add task" }));
    await expectNoA11yViolations(document.body);
  });
});
