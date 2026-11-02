import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { CustomerListState } from "../list-state";
import type { CustomerDetailDto, CustomerDto } from "../schema";
import { CustomersView } from "./customers-view";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace, refresh: vi.fn() }),
  usePathname: () => "/app/customers",
  useSearchParams: () => new URLSearchParams(search),
}));

const ID = "11111111-1111-4111-8111-111111111111";
const row = (over: Partial<CustomerDto> = {}): CustomerDto =>
  ({
    id: ID,
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
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-01T12:00:00Z",
    archivedAt: null,
    ...over,
  }) as CustomerDto;
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const meta = (n: number) => ({ page: 1, limit: 25, total: n, totalPages: 1 });
const defaults = {
  q: "",
  status: "",
  source: "",
  archived: "false",
  sort: "updated_at",
  order: "desc",
  page: 1,
  limit: 25,
} as const;

let calls: Array<{ path: string; method: string; query: URLSearchParams }>;
let related: CustomerDetailDto["related"];
let list: CustomerDto[];
let failWith: Response | null;
function install() {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({ path: url.pathname, method, query: url.searchParams });
    if (url.pathname.endsWith("/members")) return json(200, { data: [], meta: {} });
    if (method !== "GET" && failWith) return failWith;
    if (method === "DELETE") return json(204, null);
    if (method === "POST") return json(200, { data: row(), meta: {} });
    if (url.pathname === `/api/v1/customers/${ID}`)
      return json(200, { data: { ...row(), related }, meta: {} });
    return json(200, { data: list, meta: meta(list.length) });
  });
}
const view = (canWrite = true, initialState: CustomerListState = defaults) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <CustomersView
        initial={null}
        initialState={initialState}
        canWrite={canWrite}
        currentUserId="u1"
        timeZone="UTC"
      />
    </ApiClientProvider>,
  );
const openMenu = async (name: string) => {
  screen.getByRole("button", { name: `Actions for ${name}` }).focus();
  await userEvent.keyboard("{Enter}");
};

beforeEach(() => {
  search = "";
  replace.mockClear();
  notify.error.mockClear();
  notify.success.mockClear();
  related = { opportunities: 0, tasks: 0, quotes: 0, openOpportunities: 0, openTasks: 0 };
  list = [row()];
  failWith = null;
  install();
});
afterEach(() => vi.restoreAllMocks());

describe("archive and restore UX [SIT-234]", () => {
  it("the archive dialog always explains retention, and warns with counts when open opportunities or tasks remain", async () => {
    related = { opportunities: 5, tasks: 4, quotes: 0, openOpportunities: 2, openTasks: 1 };
    view();
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(dialog).toHaveTextContent("2 open opportunities and 1 open task"));
    expect(dialog).toHaveTextContent(
      "Archiving hides this customer from the active list. Related records and history are kept. You can restore it any time.",
    );
    await expectNoA11yViolations(document.body);
  });

  it("no warning when nothing is open, but the retention text is still there", async () => {
    related = { opportunities: 3, tasks: 3, quotes: 0, openOpportunities: 0, openTasks: 0 };
    view();
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    await waitFor(() => expect(calls.some((c) => c.path === `/api/v1/customers/${ID}`)).toBe(true));
    expect(dialog).not.toHaveTextContent(/open (opportunit|task)/);
    expect(dialog).toHaveTextContent("Related records and history are kept");
  });

  it("is keyboard operable: Escape cancels without a request and focus goes back to the row's actions button", async () => {
    view();
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Actions for Acme Plumbing" })).toHaveFocus(),
    );
  });

  it("a failure stays in the dialog with the message and the request id; nothing is announced as archived", async () => {
    failWith = json(500, {
      error: {
        code: "INTERNAL",
        message: "The customer could not be archived.",
        requestId: "req-77",
      },
    });
    view();
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive customer" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req-77");
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("the Archived filter writes archived=true to the URL and asks the API for archived customers; archived rows offer Restore, not Archive", async () => {
    const { unmount } = view();
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await userEvent.selectOptions(screen.getByLabelText("Show"), "true");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("archived=true"),
      expect.anything(),
    );
    unmount();
    list = [row({ archivedAt: "2026-11-01T10:00:00Z" })];
    search = "archived=true";
    view(true, { ...defaults, archived: "true" });
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await waitFor(() => expect(calls.some((c) => c.query.get("archived") === "true")).toBe(true));
    await openMenu("Acme Plumbing");
    expect(await screen.findByRole("menuitem", { name: "Restore" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
  });

  it("Restore calls POST /restore, names the customer in the toast and reloads the list; a failure toasts the request id", async () => {
    list = [row({ archivedAt: "2026-11-01T10:00:00Z" })];
    search = "archived=true";
    view(true, { ...defaults, archived: "true" });
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Customer restored", "Acme Plumbing"),
    );
    expect(calls.find((c) => c.method === "POST")!.path).toBe(`/api/v1/customers/${ID}/restore`);

    failWith = json(409, {
      error: { code: "CONFLICT", message: "Already restored.", requestId: "req-9" },
    });
    await openMenu("Acme Plumbing");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() =>
      expect(notify.error).toHaveBeenCalledWith(
        "Customer not restored",
        expect.stringContaining("req-9"),
      ),
    );
  });

  it("a viewer's row menu shows a disabled Archive with the reason, and no Restore", async () => {
    view(false);
    await screen.findByRole("link", { name: /Acme Plumbing/ });
    await openMenu("Acme Plumbing");
    const item = await screen.findByRole("menuitem", { name: /Archive \(needs edit access\)/ });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("menuitem", { name: "Restore" })).toBeNull();
  });
});
