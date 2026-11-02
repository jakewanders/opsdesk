import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { DEFAULT_PROBABILITY, totalsByStage, type Stage } from "@/lib/domain/pipeline";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "../schema";
import { OpportunityList } from "./opportunity-list";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/opportunities",
  useSearchParams: () => new URLSearchParams(search),
}));

const ME = "00000000-0000-4000-8000-0000000000aa";
const MEMBERS = [{ userId: ME, role: "owner", displayName: "Olivia Owner" }];
const NOW = "2026-11-02T10:00:00.000000+00:00";
const mk = (
  id: string,
  title: string,
  stage: Stage,
  amountCents: number,
  over: Partial<OpportunityDto> = {},
): OpportunityDto => ({
  id,
  customerId: "c1",
  customerName: "Acme Plumbing",
  title,
  description: null,
  stage,
  amountCents,
  probabilityPercent: DEFAULT_PROBABILITY[stage],
  expectedCloseDate: "2026-12-01",
  assignedTo: null,
  lostReason: null,
  closedAt: null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...over,
});
const DEALS = [
  mk("d1", "Alpha retrofit", "new", 100001),
  mk("d2", "Beta boiler", "proposal", 123450, { assignedTo: ME, expectedCloseDate: null }),
];
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: URL[];
let respondWith: (url: URL) => Response;
const metaFor = (list: OpportunityDto[], extra: Record<string, unknown> = {}) => ({
  page: 1,
  limit: 25,
  total: list.length,
  totalPages: Math.max(1, Math.ceil(list.length / 25)),
  stageTotals: totalsByStage(
    list.map((d) => ({
      stage: d.stage,
      amountCents: d.amountCents,
      probability: d.probabilityPercent,
    })),
  ),
  ...extra,
});
const render_ = (canWrite = true) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <OpportunityList canWrite={canWrite} currentUserId={ME} />
    </ApiClientProvider>,
  );

beforeEach(() => {
  search = "";
  calls = [];
  replace.mockClear();
  respondWith = () => json(200, { data: DEALS, meta: metaFor(DEALS) });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members")) return json(200, { data: MEMBERS, meta: {} });
    calls.push(url);
    return respondWith(url);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("OpportunityList [SIT-228]", () => {
  it("shows title, customer, stage (icon+word), amount from cents, probability, owner and close date; rows link to the detail page", async () => {
    const { container } = render_();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const first = within(rows[1]);
    expect(first.getByRole("link", { name: "Alpha retrofit" })).toHaveAttribute(
      "href",
      "/app/opportunities/d1",
    );
    expect(first.getByRole("link", { name: "Acme Plumbing" })).toHaveAttribute(
      "href",
      "/app/customers/c1",
    );
    expect(first.getByText("New")).toBeInTheDocument();
    expect(first.getByText("$1,000.01")).toBeInTheDocument();
    expect(first.getByText("Unassigned")).toBeInTheDocument();
    expect(first.getByText("Dec 1, 2026")).toBeInTheDocument();
    const second = within(rows[2]);
    expect(second.getByText("$1,234.50")).toBeInTheDocument();
    await waitFor(() => expect(second.getByText("You")).toBeInTheDocument());
    expect(second.getByText("Not set")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("the summary strip shows the API's per-stage count and total, not a recomputation of the visible rows", async () => {
    respondWith = () =>
      json(200, {
        data: DEALS,
        meta: metaFor(DEALS, {
          total: 40,
          totalPages: 2,
          stageTotals: { ...totalsByStage([]), won: { count: 7, amountCents: 987654321 } },
        }),
      });
    render_();
    const strip = await screen.findByRole("region", { name: "Totals by stage" });
    expect(strip).toHaveTextContent("7 deals · $9,876,543");
    expect(strip).toHaveTextContent("0 deals · $0");
    expect(screen.getByText("Showing 1 to 2 of 40")).toBeInTheDocument();
  });

  it("filters and sorting are written to the URL and sent to the API", async () => {
    const user = userEvent.setup();
    render_();
    await screen.findByRole("table");
    await user.selectOptions(screen.getByLabelText("Stage"), "proposal");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("stage=proposal"),
      expect.anything(),
    );
    await user.selectOptions(screen.getByLabelText("Owner"), ME);
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining(`assignedTo=${ME}`),
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: /Amount/ }));
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("sort=amount_cents"),
      expect.anything(),
    );
  });

  it("the URL drives the request: query params reach the API and invalid dates are dropped", async () => {
    search = `q=boiler&stage=won&assignedTo=${ME}&closeFrom=2026-01-01&closeTo=bad&sort=amount_cents&order=asc&page=2&limit=10`;
    render_();
    await screen.findByRole("table");
    const sent = calls.at(-1)!.searchParams;
    expect(Object.fromEntries(sent)).toMatchObject({
      q: "boiler",
      stage: "won",
      assignedTo: ME,
      closeFrom: "2026-01-01",
      sort: "amount_cents",
      order: "asc",
      page: "2",
      limit: "10",
    });
    expect(sent.has("closeTo")).toBe(false);
  });

  it("switching to the board writes view=board", async () => {
    const user = userEvent.setup();
    render_();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("view=board"),
      expect.anything(),
    );
  });

  it("empty workspace: 'Create your first opportunity' for people who can write, none for viewers", async () => {
    respondWith = () => json(200, { data: [], meta: metaFor([]) });
    const { unmount } = render_(true);
    expect(
      await screen.findByRole("link", { name: /Create your first opportunity/ }),
    ).toHaveAttribute("href", "/app/opportunities/new");
    unmount();
    render_(false);
    await screen.findByText("No opportunities yet");
    expect(screen.queryByRole("link", { name: /Create your first/ })).toBeNull();
  });

  it("no results with filters on: says so and Clear filters resets them", async () => {
    search = "q=zzz&stage=won";
    respondWith = () => json(200, { data: [], meta: metaFor([]) });
    const user = userEvent.setup();
    render_();
    await screen.findByText("No opportunities match");
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenLastCalledWith(
      expect.not.stringContaining("stage="),
      expect.anything(),
    );
  });

  it("a page past the end offers the first page rather than the empty state", async () => {
    search = "page=9";
    respondWith = () => json(200, { data: [], meta: metaFor(DEALS, { total: 2, page: 9 }) });
    render_();
    expect(await screen.findByText("There are no opportunities on this page")).toBeInTheDocument();
  });

  it("an API failure shows an error with a retry that refetches", async () => {
    respondWith = () =>
      json(404, { error: { code: "NOT_FOUND", message: "Boom", requestId: "req-1" } });
    const user = userEvent.setup();
    render_();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Opportunities could not be loaded");
    const before = calls.length;
    respondWith = () => json(200, { data: DEALS, meta: metaFor(DEALS) });
    await user.click(within(alert).getByRole("button", { name: /Try again|Retry/ }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    await screen.findByRole("table");
  });

  it("paging buttons move through pages via the URL", async () => {
    respondWith = () =>
      json(200, { data: DEALS, meta: metaFor(DEALS, { total: 60, totalPages: 3 }) });
    const user = userEvent.setup();
    render_();
    await screen.findByRole("table");
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("page=2"), expect.anything());
  });
});
