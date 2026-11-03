import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { QuoteDetailDto } from "../schema";
import { QuoteEditor } from "./quote-editor";
import { QuoteReadOnly } from "./quote-readonly";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: push, refresh: vi.fn() }),
  usePathname: () => "/app/quotes/new",
  useSearchParams: () => new URLSearchParams(),
}));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const CUSTOMER = {
  customerId: "c0000000-0000-4000-8000-000000000001",
  customerName: "Acme Plumbing",
};
const NOW = "2026-11-02T10:00:00.000000+00:00";
const saved = (over: Partial<QuoteDetailDto> = {}): QuoteDetailDto => ({
  id: "q0000000-0000-4000-8000-000000000001",
  quoteNumber: "Q-000007",
  customerId: CUSTOMER.customerId,
  customerName: CUSTOMER.customerName,
  opportunityId: null,
  title: "Kitchen rewiring",
  currency: "USD",
  status: "draft",
  issueDate: "2026-11-02",
  validUntil: null,
  taxRateBps: 825,
  discountCents: 500,
  subtotalCents: 12498,
  taxCents: 990,
  totalCents: 12988,
  notes: null,
  version: 2,
  revisesQuoteId: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  items: [
    {
      id: "i1",
      position: 1,
      description: "Widget",
      quantity: 2,
      unitPriceCents: 1999,
      lineTotalCents: 3998,
    },
    {
      id: "i2",
      position: 2,
      description: "Gadget",
      quantity: 1,
      unitPriceCents: 5000,
      lineTotalCents: 5000,
    },
    {
      id: "i3",
      position: 3,
      description: "Permit fee",
      quantity: 1,
      unitPriceCents: 3500,
      lineTotalCents: 3500,
    },
  ],
  revises: null,
  revisions: [],
  statusHistory: [],
  ...over,
});

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; init: RequestInit }>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function mockApi(handler: Handler = () => respond(200, { data: saved(), meta: {} })) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push({ url: String(u), init: init ?? {} });
    if (url.pathname.endsWith("/opportunities")) return respond(200, { data: [], meta: {} });
    return handler(url, init ?? {});
  });
}
const writes = () => calls.filter((c) => c.init.method === "POST" || c.init.method === "PATCH");
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));
const header = (c: { init: RequestInit }, name: string) =>
  (c.init.headers as Record<string, string>)[name];

const renderEditor = (props: Partial<React.ComponentProps<typeof QuoteEditor>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <Link href="/app/quotes">Quotes link</Link>
      <QuoteEditor {...props} />
    </ApiClientProvider>,
  );
const descriptions = () =>
  screen.getAllByLabelText(/^Description, line/).map((i) => (i as HTMLInputElement).value);
const totals = () => screen.getByRole("region", { name: "Totals" });

beforeEach(() => {
  push.mockClear();
  notify.success.mockClear();
  notify.info.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function fillLine(n: number, description: string, quantity: string, price: string) {
  const d = screen.getByLabelText(`Description, line ${n}`);
  await userEvent.clear(d);
  await userEvent.type(d, description);
  const q = screen.getByLabelText(`Quantity, line ${n}`);
  await userEvent.clear(q);
  await userEvent.type(q, quantity);
  const p = screen.getByLabelText(`Unit price in dollars, line ${n}`);
  await userEvent.clear(p);
  await userEvent.type(p, price);
}

describe("QuoteEditor: new quote", () => {
  it("starts with one empty line and no totals, labelled as a preview", () => {
    mockApi();
    renderEditor({ initial: CUSTOMER });
    expect(descriptions()).toEqual([""]);
    expect(within(totals()).getByText("Preview")).toBeInTheDocument();
    expect(within(totals()).getByText(/Fix the highlighted fields/)).toBeInTheDocument();
  });

  it("the preview follows what is typed, with the shared half-up arithmetic", async () => {
    mockApi();
    renderEditor({ initial: CUSTOMER });
    await fillLine(1, "Widget", "2", "19.99");
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    await fillLine(2, "Gadget", "1", "50.00");
    await userEvent.clear(screen.getByLabelText(/^Discount \(USD\)/));
    await userEvent.type(screen.getByLabelText(/^Discount \(USD\)/), "5.00");
    await userEvent.clear(screen.getByLabelText(/^Tax rate/));
    await userEvent.type(screen.getByLabelText(/^Tax rate/), "8.25");
    const t = within(totals());
    expect(t.getByText("$89.98")).toBeInTheDocument(); // subtotal
    expect(t.getByText("-$5.00")).toBeInTheDocument();
    expect(t.getByText("$7.01")).toBeInTheDocument(); // 84.98 x 8.25% = 7.01085
    expect(t.getByText("$91.99")).toBeInTheDocument();
    expect(t.getByText("Tax (8.25%)")).toBeInTheDocument();
    // each row shows its own total
    expect(screen.getByTestId("quote-line-1")).toHaveTextContent("$39.98");
    expect(screen.getByTestId("quote-line-2")).toHaveTextContent("$50.00");
    await userEvent.clear(screen.getByLabelText(/^Tax rate/));
    await userEvent.type(screen.getByLabelText(/^Tax rate/), "10");
    await userEvent.clear(screen.getByLabelText(/^Discount \(USD\)/));
    await userEvent.type(screen.getByLabelText(/^Discount \(USD\)/), "0");
    expect(within(totals()).getByText("$9.00")).toBeInTheDocument(); // 89.98 x 10% = 8.998 -> 899.8 cents rounds to 900
    expect(within(totals()).getByText("$98.98")).toBeInTheDocument();
  });

  it("names every problem on its own field and line, in a focused summary, and sends nothing", async () => {
    mockApi();
    renderEditor();
    await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
    const summary = screen.getByText("There is a problem").closest('[role="alert"]') as HTMLElement;
    expect(summary).toHaveFocus();
    for (const name of [/Customer/, /Title/, /Line 1, description/, /Line 1, unit price/])
      expect(within(summary).getByRole("link", { name })).toBeInTheDocument();
    const description = screen.getByLabelText("Description, line 1");
    expect(description).toHaveAttribute("aria-invalid", "true");
    expect(
      document.getElementById(description.getAttribute("aria-describedby")!),
    ).toHaveTextContent(/2 to 300/);
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["0", "1.00", /quantity/i],
    ["1.5", "1.00", /quantity/i],
    ["100001", "1.00", /quantity/i],
    ["1", "-1", /negative|0 or more/i],
    ["1", "1.001", /2 decimal/i],
    ["1", "1,000,000.01", /1,000,000/],
  ])("a line of quantity %s and price %s is refused at the line", async (qty, price, message) => {
    mockApi();
    renderEditor({ initial: CUSTOMER });
    await userEvent.type(screen.getByLabelText(/Title/), "Valid title");
    await fillLine(1, "Widget", qty, price);
    await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
    const bad =
      qty === "1"
        ? screen.getByLabelText("Unit price in dollars, line 1")
        : screen.getByLabelText("Quantity, line 1");
    expect(bad).toHaveAttribute("aria-invalid", "true");
    expect(document.getElementById(bad.getAttribute("aria-describedby")!)?.textContent).toMatch(
      message,
    );
    expect(writes()).toHaveLength(0);
  });

  it("refuses a discount above the subtotal, and a tax rate over 100% or with 3 decimals", async () => {
    mockApi();
    renderEditor({ initial: CUSTOMER });
    await userEvent.type(screen.getByLabelText(/Title/), "Valid title");
    await fillLine(1, "Widget", "1", "10.00");
    await userEvent.clear(screen.getByLabelText(/^Discount \(USD\)/));
    await userEvent.type(screen.getByLabelText(/^Discount \(USD\)/), "10.01");
    await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
    expect(screen.getByLabelText(/^Discount \(USD\)/)).toHaveAttribute("aria-invalid", "true");
    expect(within(totals()).getByText(/Fix the highlighted/)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/^Discount \(USD\)/));
    await userEvent.type(screen.getByLabelText(/^Discount \(USD\)/), "0");
    for (const rate of ["100.01", "8.255"]) {
      await userEvent.clear(screen.getByLabelText(/^Tax rate/));
      await userEvent.type(screen.getByLabelText(/^Tax rate/), rate);
      await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
      expect(screen.getByLabelText(/^Tax rate/), rate).toHaveAttribute("aria-invalid", "true");
    }
    expect(writes()).toHaveLength(0);
  });

  it("creates the quote: cents and basis points, no totals, an idempotency key, then the editor opens on the new quote", async () => {
    mockApi((_u, init) =>
      respond(init.method === "POST" ? 201 : 200, { data: saved({ version: 1 }), meta: {} }),
    );
    renderEditor({ initial: CUSTOMER });
    await userEvent.type(screen.getByLabelText(/Title/), "Kitchen rewiring");
    await fillLine(1, "Widget", "2", "19.99");
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    await fillLine(2, "Gadget", "1", "50.00");
    await userEvent.clear(screen.getByLabelText(/^Discount \(USD\)/));
    await userEvent.type(screen.getByLabelText(/^Discount \(USD\)/), "5");
    await userEvent.clear(screen.getByLabelText(/^Tax rate/));
    await userEvent.type(screen.getByLabelText(/^Tax rate/), "8.25");
    await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [call] = writes();
    expect(call.url).toContain("/quotes");
    expect(body(call)).toMatchObject({
      customerId: CUSTOMER.customerId,
      title: "Kitchen rewiring",
      taxRateBps: 825,
      discountCents: 500,
      items: [
        { description: "Widget", quantity: 2, unitPriceCents: 1999 },
        { description: "Gadget", quantity: 1, unitPriceCents: 5000 },
      ],
    });
    for (const k of ["totalCents", "subtotalCents", "taxCents", "quoteNumber", "status"])
      expect(body(call)).not.toHaveProperty(k);
    expect(header(call, "Idempotency-Key")).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/quotes/q0000000-0000-4000-8000-000000000001"),
    );
    expect(notify.success).toHaveBeenCalledWith("Quote created", "Q-000007: Kitchen rewiring");
  });

  it("a server refusal is placed on its field in words (a discount the database refuses)", async () => {
    mockApi((_u, init) =>
      init.method === "POST"
        ? respond(422, {
            error: {
              code: "CUSTOMER_ARCHIVED",
              message: "That customer is archived. Restore the customer to quote them.",
              requestId: "r1",
            },
          })
        : respond(200, { data: saved(), meta: {} }),
    );
    renderEditor({ initial: CUSTOMER });
    await userEvent.type(screen.getByLabelText(/Title/), "Valid title");
    await fillLine(1, "Widget", "1", "10.00");
    await userEvent.click(screen.getByRole("button", { name: "Create quote" }));
    const customer = await screen.findByRole("combobox", { name: /Customer/ });
    await waitFor(() => expect(customer).toHaveAttribute("aria-invalid", "true"));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("QuoteEditor: line items", () => {
  it("reorders with the move buttons, announces the new position, and saves positions in that order", async () => {
    mockApi();
    renderEditor({ quote: saved() });
    expect(descriptions()).toEqual(["Widget", "Gadget", "Permit fee"]);
    expect(screen.getByRole("button", { name: "Move line 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move line 3 down" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move line 3 up" }));
    expect(descriptions()).toEqual(["Widget", "Permit fee", "Gadget"]);
    expect(screen.getByText("Line moved to position 2 of 3.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Move line 1 down" }));
    expect(descriptions()).toEqual(["Permit fee", "Widget", "Gadget"]);
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0]).items.map((i: { description: string }) => i.description)).toEqual([
      "Permit fee",
      "Widget",
      "Gadget",
    ]);
    expect(body(writes()[0]).expectedVersion).toBe(2);
  });

  it("reordering works from the keyboard alone (Tab to the button, Enter)", async () => {
    mockApi();
    renderEditor({ quote: saved() });
    screen.getByRole("button", { name: "Move line 2 up" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(descriptions()).toEqual(["Gadget", "Widget", "Permit fee"]);
    screen.getByRole("button", { name: "Move line 3 up" }).focus();
    await userEvent.keyboard(" ");
    expect(descriptions()).toEqual(["Gadget", "Permit fee", "Widget"]);
  });

  it("adds and removes lines; the last line cannot be removed", async () => {
    mockApi();
    renderEditor({ initial: CUSTOMER });
    expect(screen.getByRole("button", { name: "Remove line 1" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    await userEvent.click(screen.getByRole("button", { name: "Add line" }));
    expect(descriptions()).toHaveLength(3);
    await userEvent.type(screen.getByLabelText("Description, line 2"), "Second");
    await userEvent.click(screen.getByRole("button", { name: "Remove line 1" }));
    expect(descriptions()).toEqual(["Second", ""]);
    expect(screen.getByText("Line 1 removed.")).toBeInTheDocument();
  });

  it("exposes the lines as a table with row headers and a caption", () => {
    mockApi();
    renderEditor({ quote: saved() });
    const table = screen.getByRole("table", { name: /Line items of this quote/ });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent?.replace(/\s+/g, " ").trim()),
    ).toEqual(["Order#", "Description", "Quantity", "Unit price (USD)", "Line total", "Remove"]);
    expect(within(table).getAllByRole("rowheader")).toHaveLength(3);
  });
});

describe("QuoteEditor: editing a draft", () => {
  it("loads the saved values and previews exactly the saved totals", () => {
    mockApi();
    renderEditor({ quote: saved() });
    expect((screen.getByLabelText(/^Tax rate/) as HTMLInputElement).value).toBe("8.25");
    expect((screen.getByLabelText(/^Discount \(USD\)/) as HTMLInputElement).value).toBe("5.00");
    const t = within(totals());
    expect(t.getByText("$124.98")).toBeInTheDocument();
    expect(t.getByText("$9.90")).toBeInTheDocument(); // 119.98 x 8.25% = 9.89835 -> 9.90
    expect(t.getByText("$129.88")).toBeInTheDocument();
  });

  it("after saving, the server's totals are shown as saved and agree with the preview", async () => {
    mockApi();
    renderEditor({ quote: saved() });
    await userEvent.type(screen.getByLabelText(/Notes/), "Net 30");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await within(totals()).findByText("Saved")).toBeInTheDocument();
    expect(within(totals()).getByText(/server calculated and saved/)).toBeInTheDocument();
    expect(notify.success).toHaveBeenCalledWith("Draft saved", "Q-000007: Kitchen rewiring");
    expect(push).not.toHaveBeenCalled(); // editing stays on the page
  });

  it("warns when the saved totals differ from the preview, and shows the saved ones", async () => {
    mockApi(() =>
      respond(200, { data: saved({ taxCents: 991, totalCents: 12989, version: 3 }), meta: {} }),
    );
    renderEditor({ quote: saved() });
    await userEvent.type(screen.getByLabelText(/Notes/), "x");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const alert = await screen.findByText("The saved totals differ from the preview");
    const box = alert.closest('[role="alert"]') as HTMLElement;
    expect(box).toHaveTextContent("tax: preview $9.90, saved $9.91");
    expect(box).toHaveTextContent("Saved total: $129.89");
  });

  it("a stale version (409) opens a reload dialog; loading the latest replaces the form and the version", async () => {
    let first = true;
    mockApi((url, init) => {
      if (init.method === "PATCH") {
        if (first) {
          first = false;
          return respond(409, {
            error: {
              code: "STALE_EDIT",
              message: "changed",
              requestId: "r",
              meta: { current: { version: 3 } },
            },
          });
        }
        return respond(200, { data: saved({ version: 4 }), meta: {} });
      }
      return respond(200, {
        data: saved({ title: "Changed by someone else", version: 3 }),
        meta: {},
      });
    });
    renderEditor({ quote: saved() });
    await userEvent.type(screen.getByLabelText(/Notes/), "mine");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Someone else changed this quote",
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "Load the latest version" }));
    await waitFor(() =>
      expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe(
        "Changed by someone else",
      ),
    );
    expect((screen.getByLabelText(/Notes/) as HTMLTextAreaElement).value).toBe("");
    await userEvent.type(screen.getByLabelText(/Notes/), "again");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(body(writes()[1]).expectedVersion).toBe(3);
  });

  it("a quote sent meanwhile (409 QUOTE_LOCKED) says so and offers the current quote", async () => {
    mockApi((_u, init) =>
      init.method === "PATCH"
        ? respond(409, {
            error: {
              code: "QUOTE_LOCKED",
              message: "A quote that has been sent cannot be edited.",
              requestId: "r",
            },
          })
        : respond(200, { data: saved({ status: "sent" }), meta: {} }),
    );
    renderEditor({ quote: saved() });
    await userEvent.type(screen.getByLabelText(/Notes/), "late");
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(
      await screen.findByText("This quote was sent while you were editing."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open the current quote" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/quotes/q0000000-0000-4000-8000-000000000001"),
    );
  });

  it("leaving with unsaved changes asks first; an untouched form leaves freely", async () => {
    mockApi();
    renderEditor({ quote: saved() });
    await userEvent.click(screen.getByRole("link", { name: "Quotes link" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("...and a changed form is held back until the person confirms", async () => {
    mockApi();
    renderEditor({ quote: saved() });
    await userEvent.type(screen.getByLabelText(/Notes/), "edited");
    await userEvent.click(screen.getByRole("link", { name: "Quotes link" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(push).toHaveBeenCalledWith("/app/quotes");
  });
});

describe("QuoteReadOnly", () => {
  const sent = saved({ status: "sent", version: 3 });
  const renderReadOnly = (quote = sent, canWrite = true) =>
    render(
      <ApiClientProvider organizationId="org-1">
        <QuoteReadOnly quote={quote} canWrite={canWrite} />
      </ApiClientProvider>,
    );

  it("a sent quote has no inputs at all: nothing financial can be edited", () => {
    mockApi();
    renderReadOnly();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(
      "This quote is sent, so its amounts and lines can no longer change.",
    );
    expect(
      within(screen.getByRole("table"))
        .getAllByRole("rowheader")
        .map((r) => r.textContent),
    ).toEqual(["Widget", "Gadget", "Permit fee"]);
    expect(within(totals()).getByText("$129.88")).toBeInTheDocument();
  });

  it("a writer can create a revision, which opens the new draft; the original is not touched", async () => {
    mockApi((_u, init) =>
      respond(init.method === "POST" ? 201 : 200, {
        data: saved({
          id: "q0000000-0000-4000-8000-000000000002",
          quoteNumber: "Q-000008",
          revisesQuoteId: sent.id,
        }),
        meta: {},
      }),
    );
    renderReadOnly();
    await userEvent.click(screen.getByRole("button", { name: "Create revision" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/quotes/q0000000-0000-4000-8000-000000000002"),
    );
    expect(writes()).toHaveLength(1);
    expect(writes()[0].url).toContain(`/quotes/${sent.id}/revise`);
    expect(notify.success).toHaveBeenCalledWith(
      "Revision created",
      "Q-000008 is a new draft of Q-000007.",
    );
  });

  it("an open draft revision is linked instead of offering a second; a viewer is offered nothing", () => {
    mockApi();
    const { unmount } = renderReadOnly(
      saved({
        status: "sent",
        revisions: [{ id: "q9", quoteNumber: "Q-000009", status: "draft", createdAt: NOW }],
      }),
    );
    expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open draft revision Q-000009" })).toBeInTheDocument();
    unmount();
    renderReadOnly(sent, false);
    expect(screen.queryByRole("button", { name: "Create revision" })).toBeNull();
  });

  it("a draft seen by someone who may not edit it is read-only too", () => {
    mockApi();
    renderReadOnly(saved(), false);
    expect(screen.getByText(/view this draft but not edit it/)).toBeInTheDocument();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  });
});

describe("accessibility", () => {
  it("the editor, with and without errors, and the read-only view have no axe violations", async () => {
    mockApi();
    const { container, unmount } = renderEditor({ quote: saved() });
    await expectNoA11yViolations(container);
    await userEvent.clear(screen.getByLabelText("Quantity, line 1"));
    await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("There is a problem");
    await expectNoA11yViolations(container);
    unmount();
    const ro = render(
      <ApiClientProvider organizationId="org-1">
        <QuoteReadOnly quote={saved({ status: "sent" })} canWrite />
      </ApiClientProvider>,
    );
    await expectNoA11yViolations(ro.container);
  });
});
