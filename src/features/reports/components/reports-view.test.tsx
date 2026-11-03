import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { REPORT_METRICS } from "@/lib/domain/reports";
import { expectNoA11yViolations } from "@/test/axe";
import type { ReportDto } from "../service";
import { ReportsView } from "./reports-view";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
// jsdom cannot lay out SVG: the drawing is stubbed and checked in a real browser (e2e/reports.spec.ts). What is tested here is
// that each chart gets exactly the API's data, and how it is presented around it.
vi.mock("./series-chart-impl", () => ({
  default: ({ rows, kind }: { rows: unknown[]; kind: string }) => (
    <p data-testid={`chart-${kind}`}>{rows.length} points</p>
  ),
}));
vi.mock("@/features/dashboard/components/stage-chart-impl", () => ({
  default: () => <p>stage chart drawn</p>,
}));
const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/reports",
  useSearchParams: () => new URLSearchParams(search),
}));
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client/save-file", () => ({ saveBlob }));

const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
    return {
      start: d,
      end: d,
      opportunitiesCreated: 0,
      opportunitiesWon: 0,
      opportunitiesLost: 0,
      wonAmountCents: 0,
      tasksCompleted: 0,
    };
  });
const stage = (count = 0) => ({ count, amountCents: count * 1000 });
const report = (over: Partial<ReportDto> = {}): ReportDto => {
  const buckets = days("2026-10-04", 30);
  buckets[3] = {
    ...buckets[3],
    opportunitiesCreated: 2,
    opportunitiesWon: 1,
    opportunitiesLost: 1,
    tasksCompleted: 3,
  };
  buckets[10] = { ...buckets[10], opportunitiesCreated: 1, opportunitiesWon: 2, tasksCompleted: 1 };
  return {
    generatedAt: "2026-11-02T15:30:00.000Z",
    timeZone: "America/New_York",
    today: "2026-11-02",
    range: { from: "2026-10-04", to: "2026-11-02", days: 30, bucket: "day", preset: 30 },
    buckets,
    customersBySource: { referral: 2, website: 1, outbound: 0, other: 0 },
    opportunitiesByStage: {
      new: stage(2),
      qualified: stage(1),
      proposal: stage(0),
      negotiation: stage(1),
      won: stage(3),
      lost: stage(1),
    },
    metrics: REPORT_METRICS,
    ...over,
  };
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: string[];
let respond: (url: URL) => Response | Promise<Response>;
beforeEach(() => {
  calls = [];
  search = "";
  replace.mockClear();
  notify.error.mockClear();
  saveBlob.mockClear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = new URL(String(u), "http://localhost");
    calls.push(url.pathname + url.search);
    return respond(url);
  });
  respond = () => json(200, { data: report(), meta: {} });
});
afterEach(() => vi.restoreAllMocks());

const state = (s: string) =>
  ({ range: "30", from: "", to: "", ...Object.fromEntries(new URLSearchParams(s)) }) as never;
const renderView = (props: Partial<React.ComponentProps<typeof ReportsView>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <ReportsView
        initial={null}
        initialState={state("")}
        canWrite
        isDemo={false}
        timeZone="America/New_York"
        workspaceCreatedAt={null}
        {...props}
      />
    </ApiClientProvider>,
  );

describe("ReportsView", () => {
  it("states the exact range in the workspace's zone and draws every chart from the API's data", async () => {
    renderView();
    expect(await screen.findByText("Oct 4 to Nov 2, 2026, America/New_York")).toBeInTheDocument();
    expect(screen.getByText(/30 days, by day/)).toBeInTheDocument();
    expect(calls[0]).toBe("/api/v1/reports?range=30");
    expect(await screen.findAllByTestId("chart-line")).toHaveLength(1);
    expect(screen.getByTestId("chart-line")).toHaveTextContent("30 points");
    expect(screen.getByTestId("chart-bar")).toHaveTextContent("30 points");
    expect(screen.getByTestId("chart-hbar")).toHaveTextContent("4 points");
    expect(screen.getByText("stage chart drawn")).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it("labels each chart with what it is counted on: events on the day they happened, stages as of now", async () => {
    renderView();
    await screen.findByTestId("chart-line");
    expect(screen.getAllByText("Counted on the day it happened")).toHaveLength(3);
    expect(screen.getAllByText("As of right now")).toHaveLength(1);
    // the descriptions are the API's
    expect(screen.getByText(/by the day they were closed/)).toBeInTheDocument();
    expect(screen.getByText(/a snapshot of today, not of the selected range/)).toBeInTheDocument();
  });

  it("each chart has its numbers as a table, with totals that match the buckets", async () => {
    const user = userEvent.setup();
    renderView();
    const trend = (
      await screen.findByRole("heading", { name: "Opportunities created, won and lost" })
    ).closest("section")!;
    await user.click(within(trend).getByRole("button", { name: "View as table" }));
    const table = within(trend).getByRole("table", { name: /as a table/ });
    const total = within(table).getByRole("row", { name: /^Total/ });
    const cells = within(total)
      .getAllByRole("cell")
      .map((c) => c.textContent);
    expect(cells).toEqual(["3", "3", "1"]); // created 2+1, won 1+2, lost 1
    await user.click(within(trend).getByRole("button", { name: "View as chart" }));
    expect(within(trend).getByTestId("chart-line")).toBeInTheDocument();
  });

  it("shows the win rate from the range's won and lost deals", async () => {
    renderView();
    expect(await screen.findByText("Win rate 75%")).toBeInTheDocument();
    expect(screen.getByText(/3 won of 4 closed in this range/)).toBeInTheDocument();
  });

  it("changing the range changes the URL and asks the API for that range", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chart-line");
    await user.click(screen.getByRole("radio", { name: "7 days" }));
    expect(replace).toHaveBeenCalledWith("/app/reports?range=7", { scroll: false });
  });

  it("follows a range from the URL and asks for exactly that", async () => {
    search = "range=90";
    respond = () =>
      json(200, {
        data: report({
          range: { from: "2026-08-05", to: "2026-11-02", days: 90, bucket: "week", preset: 90 },
        }),
        meta: {},
      });
    renderView({ initialState: state("range=90") });
    expect(await screen.findByText(/90 days, by week/)).toBeInTheDocument();
    expect(calls[0]).toBe("/api/v1/reports?range=90");
    expect(screen.getByRole("radio", { name: "90 days" })).toBeChecked();
  });

  it("Custom starts from the range on screen and applies two dates to the URL", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chart-line");
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    expect(replace).toHaveBeenLastCalledWith(
      "/app/reports?range=custom&from=2026-10-04&to=2026-11-02",
      { scroll: false },
    );
  });

  it("custom dates: an end before the start is refused in words, nothing is requested or changed", async () => {
    search = "range=custom&from=2026-10-04&to=2026-11-02";
    const user = userEvent.setup();
    renderView({ initialState: state(search) });
    await screen.findByTestId("chart-line");
    replace.mockClear();
    fireDate(screen.getByLabelText("To (included)"), "2026-10-01");
    await user.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The end date is before the start date.",
    );
    expect(screen.getByLabelText("To (included)")).toHaveAttribute("aria-invalid", "true");
    expect(replace).not.toHaveBeenCalled();
    fireDate(screen.getByLabelText("To (included)"), "2026-10-20");
    await user.click(screen.getByRole("button", { name: "Apply dates" }));
    expect(replace).toHaveBeenCalledWith(
      "/app/reports?range=custom&from=2026-10-04&to=2026-10-20",
      { scroll: false },
    );
  });

  it("a range with no events says so in each event chart; the stage chart still shows now", async () => {
    respond = () =>
      json(200, {
        data: report({
          buckets: days("2026-10-04", 30),
          customersBySource: { referral: 0, website: 0, outbound: 0, other: 0 },
        }),
        meta: {},
      });
    renderView();
    expect(
      await screen.findByText(
        /No opportunities were created, won or lost between Oct 4 to Nov 2, 2026/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/No tasks were completed between/)).toBeInTheDocument();
    expect(screen.getByText(/No customers were added between/)).toBeInTheDocument();
    expect(screen.getByText("stage chart drawn")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-line")).not.toBeInTheDocument();
    expect(screen.getByText(/Win rate appears once a deal is won or lost/)).toBeInTheDocument();
  });

  it("a workspace with nothing at all gets one explanation and a next step", async () => {
    const zero = { count: 0, amountCents: 0 };
    respond = () =>
      json(200, {
        data: report({
          buckets: days("2026-10-04", 30),
          customersBySource: { referral: 0, website: 0, outbound: 0, other: 0 },
          opportunitiesByStage: {
            new: zero,
            qualified: zero,
            proposal: zero,
            negotiation: zero,
            won: zero,
            lost: zero,
          },
        }),
        meta: {},
      });
    renderView();
    expect(
      await screen.findByRole("heading", { name: "Nothing to report yet" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add customer" })).toHaveAttribute(
      "href",
      "/app/customers/new",
    );
  });

  it("annotates a range that starts before the workspace existed", async () => {
    renderView({ workspaceCreatedAt: "2026-10-20T14:00:00Z" });
    expect(await screen.findByRole("note")).toHaveTextContent(
      "This workspace was created on 2026-10-20, so the earlier days in this range have no data.",
    );
  });

  it("a demo guest sees the fictional-data note", async () => {
    renderView({ isDemo: true });
    expect(await screen.findByText(/fictional demonstration data/)).toBeInTheDocument();
  });

  it("a failed load says so with the request id and recovers on retry", async () => {
    let fail = true;
    respond = () =>
      fail
        ? json(404, { error: { code: "NOT_FOUND", message: "Nope", requestId: "req-9" } })
        : json(200, { data: report(), meta: {} });
    const user = userEvent.setup();
    renderView();
    expect(await screen.findByText("The reports could not be loaded")).toBeInTheDocument();
    expect(screen.getByText(/req-9/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByTestId("chart-line")).toBeInTheDocument();
  });

  it("Export CSV downloads the file for the range on screen", async () => {
    respond = (url) =>
      url.pathname.endsWith("/exports/reports")
        ? new Response("section,key\r\n", {
            status: 200,
            headers: {
              "Content-Type": "text/csv",
              "Content-Disposition": 'attachment; filename="reports-2026-11-02.csv"',
            },
          })
        : json(200, { data: report(), meta: {} });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chart-line");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
    expect(saveBlob.mock.calls[0][1]).toBe("reports-2026-11-02.csv");
    expect(calls).toContain("/api/v1/exports/reports?range=30");
  });

  it("an export failure is said in words", async () => {
    respond = (url) =>
      url.pathname.endsWith("/exports/reports")
        ? json(422, { error: { code: "X", message: "Too many", requestId: "r1" } })
        : json(200, { data: report(), meta: {} });
    const user = userEvent.setup();
    renderView();
    await screen.findByTestId("chart-line");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(notify.error.mock.calls[0][0]).toBe("The report could not be exported");
  });
});

function fireDate(input: HTMLElement, value: string) {
  // a date input's value is set directly (the picker is the browser's)
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
