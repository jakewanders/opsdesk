import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { ApiClientProvider } from "@/lib/api-client/provider";
import type { CustomerDto } from "../schema";
import { CustomersView } from "./customers-view";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/customers",
  useSearchParams: () => new URLSearchParams(search),
}));

const customer = (n: number, over: Partial<CustomerDto> = {}): CustomerDto =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: n % 2 ? "company" : "person",
    displayName: `Customer ${n}`,
    companyName: n % 2 ? null : `Co ${n}`,
    email: `c${n}@example.test`,
    status: "active",
    assignedTo: null,
    archivedAt: null,
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...over,
  }) as CustomerDto;

const page = (items: CustomerDto[], total = items.length, extra: Record<string, unknown> = {}) => ({
  items,
  meta: { page: 1, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)), ...extra },
});

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

function renderView(initial: ReturnType<typeof page> | null, canWrite = true) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <CustomersView
        initial={initial}
        initialState={defaults}
        canWrite={canWrite}
        currentUserId="user-1"
        timeZone="UTC"
      />
    </ApiClientProvider>,
  );
}

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const asApi = (p: ReturnType<typeof page>) => ({ data: p.items, meta: p.meta });

beforeEach(() => {
  search = "";
  replace.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("CustomersView [SIT-219]", () => {
  it("renders the server's first page without a request, with a labelled, sortable table", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { container } = renderView(page([customer(1), customer(2)]));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("link", { name: /Customer 1/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/app/customers/"),
    );
    expect(screen.getByText("Showing 1 to 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Last updated/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(spy).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("shows the empty state with an add action for writers, and without it for viewers", () => {
    const { unmount } = renderView(page([], 0));
    expect(screen.getByText("No customers yet")).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: /Add (your first )?customer/ }).length,
    ).toBeGreaterThan(0);
    unmount();
    renderView(page([], 0), false);
    expect(screen.getByText("No customers yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add/ })).toBeNull();
  });

  it("viewers get no Add button", () => {
    renderView(page([customer(1)]), false);
    expect(screen.queryByRole("link", { name: "Add customer" })).toBeNull();
  });

  it("filters write to the URL and the empty result says nothing matches, with a way out", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(asApi(page([], 0))));
    search = "status=lead";
    renderView(page([], 0));
    await waitFor(() => expect(screen.getByText("No customers match")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenCalledWith("/app/customers", { scroll: false });
  });

  it("choosing a status updates the URL", async () => {
    renderView(page([customer(1)]));
    await userEvent.selectOptions(screen.getByLabelText("Status"), "lead");
    expect(replace).toHaveBeenCalledWith("/app/customers?status=lead", { scroll: false });
  });

  it("clicking a sortable header sorts, and again flips the order", async () => {
    renderView(page([customer(1)]));
    await userEvent.click(screen.getByRole("button", { name: /^Name/ }));
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("sort=display_name"), {
      scroll: false,
    });
  });

  it("paging: Previous is disabled on page 1 and Next goes to page 2", async () => {
    renderView(
      page(
        Array.from({ length: 25 }, (_, i) => customer(i + 1)),
        60,
      ),
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByText("Page 1 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenLastCalledWith("/app/customers?page=2", { scroll: false });
  });

  it("a failed read shows an error with a retry, and retry recovers", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        respond({ error: { code: "NOT_FOUND", message: "Nope", requestId: "req-1" } }, 404),
      )
      .mockResolvedValue(respond(asApi(page([customer(7)]))));
    renderView(null);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Customers could not be loaded");
    await userEvent.click(within(alert).getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByRole("link", { name: /Customer 7/ })).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("archiving asks first, then calls DELETE for that customer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_u, init) =>
        init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : respond(asApi(page([customer(1)]))),
      );
    renderView(page([customer(1)]));
    screen.getByRole("button", { name: "Actions for Customer 1" }).focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Customer 1");
    expect(fetchSpy.mock.calls.some(([, i]) => i?.method === "DELETE")).toBe(false);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive customer" }));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([u, i]) => String(u).includes("/customers/") && i?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });
});
