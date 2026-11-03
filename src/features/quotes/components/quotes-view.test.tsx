import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { ApiClientProvider } from "@/lib/api-client/provider";
import type { QuoteListState } from "../list-state";
import type { QuoteDto } from "../schema";
import { QuotesView } from "./quotes-view";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/quotes",
  useSearchParams: () => new URLSearchParams(search),
}));

const quote = (n: number, over: Partial<QuoteDto> = {}): QuoteDto =>
  ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    quoteNumber: `Q-${String(n).padStart(6, "0")}`,
    customerId: "11111111-1111-4111-8111-111111111111",
    customerName: `Customer ${n}`,
    title: `Quote title ${n}`,
    status: "draft",
    issueDate: "2026-10-15",
    validUntil: n % 2 ? "2026-11-15" : null,
    totalCents: 123456 * n,
    archivedAt: null,
    ...over,
  }) as QuoteDto;
const page = (items: QuoteDto[], total = items.length) => ({
  items,
  meta: { page: 1, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
});
const defaults = {
  q: "",
  status: "",
  customerId: "",
  opportunityId: "",
  issueFrom: "",
  issueTo: "",
  archived: "false",
  sort: "updated_at",
  order: "desc",
  page: 1,
  limit: 25,
} satisfies QuoteListState as QuoteListState;
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const asApi = (p: ReturnType<typeof page>) => ({ data: p.items, meta: p.meta });
const CUSTOMERS = {
  data: [
    { id: "11111111-1111-4111-8111-111111111111", displayName: "Acme Plumbing" },
    { id: "22222222-2222-4222-8222-222222222222", displayName: "Globex" },
  ],
  meta: {},
};

function renderView(initial: ReturnType<typeof page> | null, canWrite = true, state = defaults) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <QuotesView initial={initial} initialState={state} canWrite={canWrite} />
    </ApiClientProvider>,
  );
}
/** The customer picker's own request is answered; any other request goes to `other`. */
function mockApi(other: (url: string) => Response | Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = String(u);
    if (url.includes("/api/v1/customers")) return respond(CUSTOMERS);
    return other(url);
  });
}

beforeEach(() => {
  search = "";
  replace.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("QuotesView [SIT-246]", () => {
  it("renders the server's first page: number link, title, customer, status icon+word, total, dates", async () => {
    mockApi(() => respond({}));
    const { container } = renderView(
      page([
        quote(1, { status: "sent" }),
        quote(2, { status: "approved", totalCents: 1009621 }),
        quote(3, { status: "expired" }),
      ]),
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(screen.getByRole("link", { name: "Q-000001" })).toHaveAttribute(
      "href",
      "/app/quotes/00000000-0000-4000-8000-000000000001",
    );
    expect(screen.getByText("Quote title 1")).toBeInTheDocument();
    expect(screen.getByText("Customer 2")).toBeInTheDocument();
    expect(within(table).getByText("Sent")).toBeInTheDocument();
    expect(within(table).getByText("Approved")).toBeInTheDocument();
    expect(within(table).getByText("Expired")).toBeInTheDocument();
    expect(screen.getByText("$10,096.21")).toBeInTheDocument(); // shared formatter, the server's cents
    expect(screen.getAllByText("Oct 15, 2026").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nov 15, 2026").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No end date").length).toBeGreaterThan(0);
    expect(screen.getByText("Showing 1 to 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Number/ })).not.toHaveAttribute("aria-sort");
    await expectNoA11yViolations(container);
  });

  it("empty: invites writers to create the first quote; tells viewers there are none", () => {
    mockApi(() => respond({}));
    const { unmount } = renderView(page([], 0));
    expect(screen.getByText("No quotes yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create your first quote/ })).toHaveAttribute(
      "href",
      "/app/quotes/new",
    );
    unmount();
    renderView(page([], 0), false);
    expect(screen.getByText("No quotes yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /New quote|Create your first quote/ })).toBeNull();
  });

  it("viewers get no New quote button; writers do", () => {
    mockApi(() => respond({}));
    const { unmount } = renderView(page([quote(1)]), false);
    expect(screen.queryByRole("link", { name: "New quote" })).toBeNull();
    unmount();
    renderView(page([quote(1)]), true);
    expect(screen.getByRole("link", { name: "New quote" })).toHaveAttribute(
      "href",
      "/app/quotes/new",
    );
  });

  it("filters write to the URL, the customer list feeds the customer filter, and a no-result list can be cleared", async () => {
    mockApi((url) => (url.includes("/api/v1/quotes") ? respond(asApi(page([], 0))) : respond({})));
    const user = userEvent.setup();
    renderView(page([quote(1)]));
    await user.selectOptions(screen.getByLabelText("Status"), "sent");
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("status=sent"), {
      scroll: false,
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: "Acme Plumbing" })).toBeInTheDocument(),
    );
    await user.selectOptions(
      screen.getByLabelText("Customer"),
      "22222222-2222-4222-8222-222222222222",
    );
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("customerId=2222"), {
      scroll: false,
    });
    fireDate("Issued from", "2026-10-01");
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("issueFrom=2026-10-01"), {
      scroll: false,
    });
  });

  it("shows 'no quotes match' when filters are active and there are no results", async () => {
    search = "status=rejected";
    mockApi(() => respond(asApi(page([], 0))));
    renderView(null, true, { ...defaults, status: "rejected" });
    expect(await screen.findByText("No quotes match")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenLastCalledWith("/app/quotes", { scroll: false });
  });

  it("an error says what failed, with the request id and a retry", async () => {
    mockApi(() =>
      respond({ error: { code: "NOT_FOUND", message: "Boom", requestId: "req-77" } }, 404),
    );
    renderView(null);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Quotes could not be loaded");
    expect(alert).toHaveTextContent("req-77");
    expect(within(alert).getByRole("button", { name: /retry|try again/i })).toBeInTheDocument();
  });

  it("sorting by total flips direction and marks the header", async () => {
    mockApi(() => respond(asApi(page([quote(1)]))));
    const user = userEvent.setup();
    renderView(page([quote(1)]));
    await screen.findByRole("option", { name: "Acme Plumbing" }); // let the page settle
    await user.click(screen.getByRole("button", { name: /Total/ }));
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("sort=total_cents"), {
      scroll: false,
    });
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("sort=total_cents"), {
      scroll: false,
    });
  });
});

function fireDate(label: string, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  // date inputs are set directly: userEvent.type does not drive them in jsdom
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
