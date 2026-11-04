import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { clearFreshForTests, markFresh } from "@/lib/motion/fresh";
import { expectNoA11yViolations } from "@/test/axe";
import type { QuoteDto, QuoteStatus as Status } from "../schema";
import { CustomerQuotes } from "./customer-quotes";
import { QuoteActions, targetsFor } from "./quote-actions";
import { QuoteHeader } from "./quote-header";
import { QuotePdfButton } from "./quote-pdf-button";
import { QuoteStatus } from "./quote-status";
import { RevisionChain } from "./revision-chain";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  usePathname: () => "/app/quotes/q1",
  useSearchParams: () => new URLSearchParams(),
}));

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; init: RequestInit }>;
function mockApi(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    calls.push({ url: String(u), init: init ?? {} });
    return handler(String(u), init ?? {});
  });
}
const posts = () => calls.filter((c) => c.init.method === "POST");

beforeEach(() => refresh.mockClear());
afterEach(() => vi.restoreAllMocks());

const actions = (status: Status, over: Partial<React.ComponentProps<typeof QuoteActions>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <QuoteActions
        quote={{ id: "q1", quoteNumber: "Q-000007", status, version: 3 }}
        canWrite
        isDemo={false}
        {...over}
      />
    </ApiClientProvider>,
  );

describe("QuoteStatus motion", () => {
  afterEach(() => clearFreshForTests());
  it("settles a check only for a quote that was just approved", () => {
    const { container, rerender } = render(<QuoteStatus status="approved" id="q1" />);
    expect(container.querySelector(".animate-settle")).toBeNull();
    act(() => markFresh("q1"));
    rerender(<QuoteStatus status="approved" id="q1" />);
    expect(container.querySelector(".animate-settle")).not.toBeNull();
  });
  it("does not settle for other statuses even when fresh", () => {
    act(() => markFresh("q2"));
    const { container } = render(<QuoteStatus status="sent" id="q2" />);
    expect(container.querySelector(".animate-settle")).toBeNull();
  });
});

describe("QuoteStatus", () => {
  it("shows an icon and a word for every status", () => {
    for (const [status, word] of [
      ["draft", "Draft"],
      ["sent", "Sent"],
      ["approved", "Approved"],
      ["rejected", "Rejected"],
      ["expired", "Expired"],
    ] as const) {
      const { container, unmount } = render(<QuoteStatus status={status} />);
      expect(screen.getByText(word)).toBeInTheDocument();
      expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });
});

describe("QuoteHeader", () => {
  it("names the quote, its status and its customer, and links to the list and the customer", async () => {
    const { container } = render(
      <QuoteHeader
        quote={{
          title: "Rooftop unit replacement",
          quoteNumber: "Q-000007",
          status: "sent",
          customerId: "c1",
          customerName: "Acme Plumbing",
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Rooftop unit replacement" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Q-000007")).toHaveLength(2); // the breadcrumb's current page and the identity line
    expect(screen.getByText("Sent")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Acme Plumbing" })).toHaveAttribute(
      "href",
      "/app/customers/c1",
    );
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Quotes" })).toHaveAttribute(
      "href",
      "/app/quotes",
    );
    expect(within(trail).getByText("Q-000007")).toHaveAttribute("aria-current", "page");
    await expectNoA11yViolations(container);
  });

  it("links the deal and marks archived targets, which stay reachable", async () => {
    const { container } = render(
      <QuoteHeader
        quote={{
          title: "Rooftop unit replacement",
          quoteNumber: "Q-000007",
          status: "sent",
          customerId: "c1",
          customerName: "Acme Plumbing",
          customerArchived: true,
          opportunityId: "o1",
          opportunityTitle: "Rooftop deal",
          opportunityArchived: true,
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Rooftop deal" })).toHaveAttribute(
      "href",
      "/app/opportunities/o1",
    );
    expect(screen.getByRole("link", { name: "Acme Plumbing" })).toBeInTheDocument();
    expect(screen.getAllByText("Archived")).toHaveLength(2);
    await expectNoA11yViolations(container);
  });
});

describe("RevisionChain", () => {
  it("links both ways: the earlier version and every later one, with status", async () => {
    const { container } = render(
      <RevisionChain
        quote={{
          revises: { id: "q-old", quoteNumber: "Q-000001", status: "rejected" },
          revisions: [
            {
              id: "q-new",
              quoteNumber: "Q-000009",
              status: "draft",
              createdAt: "2026-11-02T10:00:00Z",
            },
          ],
        }}
      />,
    );
    expect(screen.getByRole("link", { name: "Q-000001" })).toHaveAttribute(
      "href",
      "/app/quotes/q-old",
    );
    expect(screen.getByText(/Rejected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Q-000009" })).toHaveAttribute(
      "href",
      "/app/quotes/q-new",
    );
    expect(screen.getByText(/Revises \(earlier version\)/)).toBeInTheDocument();
    expect(screen.getByText(/Revised by \(later version\)/)).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });
  it("renders nothing for a quote that was never revised and revises nothing", () => {
    const { container } = render(<RevisionChain quote={{ revises: null, revisions: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("QuoteActions", () => {
  it("offers exactly the transitions the database allows", () => {
    expect(targetsFor("draft")).toEqual(["sent"]);
    expect(targetsFor("sent")).toEqual(["approved", "rejected", "expired"]);
    for (const s of ["approved", "rejected", "expired"] as const) expect(targetsFor(s)).toEqual([]);
  });

  it("a draft: Send asks first, then posts the transition at the version it saw, and re-reads the page", async () => {
    mockApi(() => respond(200, { data: {}, meta: {} }));
    const user = userEvent.setup();
    actions("draft");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send quote" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Send Q-000007?");
    expect(dialog).toHaveTextContent("no longer be editable");
    expect(posts()).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Send quote" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toContain("/quotes/q1/transition");
    expect(JSON.parse(String(posts()[0].init.body))).toEqual({ to: "sent", expectedVersion: 3 });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("in a demo the send dialog says it is simulated and nothing is emailed", async () => {
    mockApi(() => respond(200, { data: {}, meta: {} }));
    const user = userEvent.setup();
    actions("draft", { isDemo: true });
    await user.click(screen.getByRole("button", { name: "Send quote" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("sending is simulated");
    expect(dialog).toHaveTextContent("nothing is emailed");
  });

  it("a sent quote: Approve, Reject and Mark expired, each confirmed", async () => {
    mockApi(() => respond(200, { data: {}, meta: {} }));
    const user = userEvent.setup();
    actions("sent");
    expect(screen.queryByRole("button", { name: "Send quote" })).toBeNull();
    for (const [button, confirm, to] of [
      ["Approve", "Approve quote", "approved"],
      ["Reject", "Reject quote", "rejected"],
      ["Mark expired", "Mark expired", "expired"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: button }));
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: confirm }));
      await waitFor(() => expect(JSON.parse(String(posts().at(-1)!.init.body)).to).toBe(to));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    }
    expect(posts()).toHaveLength(3);
  });

  it("a failure stays in the dialog with the reason and the request id; nothing is refreshed", async () => {
    mockApi(() =>
      respond(409, {
        error: {
          code: "QUOTE_STATUS_TRANSITION",
          message: "That quote is already approved.",
          requestId: "req-5",
        },
      }),
    );
    const user = userEvent.setup();
    actions("sent");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve quote" }));
    expect(await within(dialog).findByText(/already approved/)).toBeInTheDocument();
    expect(dialog).toHaveTextContent("req-5");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("viewers and finished quotes get no buttons", () => {
    const { container, unmount } = actions("draft", { canWrite: false });
    expect(container).toBeEmptyDOMElement();
    unmount();
    const second = actions("approved");
    expect(second.container).toBeEmptyDOMElement();
  });
});

describe("CustomerQuotes", () => {
  const quote = (n: number, over: Partial<QuoteDto> = {}) =>
    ({
      id: `q${n}`,
      quoteNumber: `Q-00000${n}`,
      title: `Job ${n}`,
      status: "sent",
      issueDate: "2026-10-15",
      totalCents: 250000,
      ...over,
    }) as QuoteDto;
  const view = (canWrite = true) =>
    render(
      <ApiClientProvider organizationId="org-1">
        <CustomerQuotes customerId="c1" canWrite={canWrite} />
      </ApiClientProvider>,
    );

  it("lists the customer's quotes with status and total, a link to the filtered list, and New quote", async () => {
    mockApi(() =>
      respond(200, { data: [quote(1), quote(2, { status: "approved" })], meta: { total: 14 } }),
    );
    view();
    expect(await screen.findByRole("link", { name: "Q-000001: Job 1" })).toHaveAttribute(
      "href",
      "/app/quotes/q1",
    );
    expect(screen.getAllByText("$2,500.00")).toHaveLength(2);
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all 14 quotes" })).toHaveAttribute(
      "href",
      "/app/quotes?customerId=c1",
    );
    expect(screen.getByRole("link", { name: "New quote" })).toHaveAttribute(
      "href",
      "/app/quotes/new?customerId=c1",
    );
    expect(calls[0].url).toContain("customerId=c1");
  });
  it("empty: invites a writer to start one, tells a viewer there are none", async () => {
    mockApi(() => respond(200, { data: [], meta: { total: 0 } }));
    const { unmount } = view(true);
    expect(await screen.findByText("No quotes for this customer yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New quote" })).toBeInTheDocument();
    unmount();
    view(false);
    expect(await screen.findByText("No quotes for this customer yet")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "New quote" })).toBeNull();
  });
  it("a failed read says so with a retry", async () => {
    mockApi(() =>
      respond(404, { error: { code: "NOT_FOUND", message: "Nope", requestId: "req-9" } }),
    );
    view();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Quotes could not be loaded");
    expect(alert).toHaveTextContent("req-9");
  });
});

describe("QuotePdfButton", () => {
  it("fetches the PDF with the workspace header and saves it under the server's filename", async () => {
    const created: string[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(String((b as Blob).type));
      return "blob:fake";
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: Array<{ download: string; href: string }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });
    mockApi(
      () =>
        new Response("%PDF-1.4 fake", {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="Q-000007.pdf"',
          },
        }),
    );
    const user = userEvent.setup();
    render(
      <ApiClientProvider organizationId="org-1">
        <QuotePdfButton quoteId="q1" quoteNumber="Q-000007" />
      </ApiClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(calls[0].url).toBe("/api/v1/quotes/q1/pdf");
    expect((calls[0].init.headers as Record<string, string>)["X-Organization-Id"]).toBe("org-1");
    expect(clicked[0]).toEqual({ download: "Q-000007.pdf", href: "blob:fake" });
    expect(created).toEqual(["application/pdf"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled());
  });

  it("says in words when the download fails", async () => {
    const clicked = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    mockApi(() =>
      respond(404, {
        error: { code: "QUOTE_NOT_FOUND", message: "That quote was not found.", requestId: "r-1" },
      }),
    );
    const user = userEvent.setup();
    render(
      <ApiClientProvider organizationId="org-1">
        <QuotePdfButton quoteId="q1" quoteNumber="Q-000007" />
      </ApiClientProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download PDF" })).toBeEnabled());
    expect(clicked).not.toHaveBeenCalled();
  });
});
