import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { DashboardDto } from "../service";
import { RecentActivity } from "./recent-activity";
import { StageChart } from "./stage-chart";
import { stageRows } from "./stage-data";

// jsdom cannot lay out SVG, so the drawing itself is stubbed here and checked in a real browser (e2e/dashboard.spec.ts);
// what is tested here is that the chart receives exactly the API's stage data and how it is presented around it.
vi.mock("./stage-chart-impl", () => ({
  default: ({
    rows,
    animate,
  }: {
    rows: Array<{ label: string; valueLabel: string }>;
    animate: boolean;
  }) => (
    <ul data-testid="bars" data-animate={String(animate)}>
      {rows.map((r) => (
        <li key={r.label}>
          {r.label}: {r.valueLabel}
        </li>
      ))}
    </ul>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/app",
}));

const BY_STAGE: DashboardDto["opportunitiesByStage"] = {
  new: { count: 2, amountCents: 100_001 },
  qualified: { count: 1, amountCents: 250_003 },
  proposal: { count: 0, amountCents: 0 },
  negotiation: { count: 3, amountCents: 1_250_007 },
  won: { count: 2, amountCents: 900_000 },
  lost: { count: 1, amountCents: 400_000 },
};
const ZERO = Object.fromEntries(
  ["new", "qualified", "proposal", "negotiation", "won", "lost"].map((s) => [
    s,
    { count: 0, amountCents: 0 },
  ]),
) as DashboardDto["opportunitiesByStage"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("reduce"),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => vi.useRealTimers());

describe("StageChart [SIT-256]", () => {
  it("stageRows turns the API payload into rows in pipeline order with the numbers written out", () => {
    const rows = stageRows(BY_STAGE);
    expect(rows.map((r) => r.label)).toEqual([
      "New",
      "Qualified",
      "Proposal",
      "Negotiation",
      "Won",
      "Lost",
    ]);
    expect(rows.map((r) => r.valueLabel)).toEqual([
      "2 deals, $1,000",
      "1 deal, $2,500",
      "0 deals, $0",
      "3 deals, $12,500",
      "2 deals, $9,000",
      "1 deal, $4,000",
    ]);
  });

  it("draws every stage with its count and amount, and asks for no animation when reduced motion is preferred", async () => {
    render(<StageChart byStage={BY_STAGE} />);
    const bars = await screen.findByTestId("bars");
    expect(bars).toHaveAttribute("data-animate", "false");
    expect(within(bars).getByText("Negotiation: 3 deals, $12,500")).toBeInTheDocument();
    expect(within(bars).getByText("Proposal: 0 deals, $0")).toBeInTheDocument();
  });

  it("always has an equivalent table for assistive tech while the chart shows, with exact cents", async () => {
    const { container } = render(<StageChart byStage={BY_STAGE} />);
    await screen.findByTestId("bars");
    const table = screen.getByRole("table", { name: /Opportunities by stage: 9 in total/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(6);
    expect(within(rows[3]).getByRole("rowheader", { name: "Negotiation" })).toBeInTheDocument();
    expect(
      within(rows[3])
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["3", "$12,500.07"]);
    expect(table.closest("div")).toHaveClass("sr-only");
    await expectNoA11yViolations(container);
  });

  it("'View as table' swaps the chart for the same table, visibly, and back", async () => {
    const user = userEvent.setup();
    const { container } = render(<StageChart byStage={BY_STAGE} />);
    await screen.findByTestId("bars");
    const toggle = screen.getByRole("button", { name: "View as table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(screen.queryByTestId("bars")).toBeNull();
    const table = screen.getByRole("table");
    expect(table.closest("div")).not.toHaveClass("sr-only");
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(screen.getByRole("button", { name: "View as chart" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "View as chart" }));
    expect(await screen.findByTestId("bars")).toBeInTheDocument();
  });

  it("every stage leads to the opportunities list filtered to it: from the chips, from the visible table, and from a bar [SIT-270]", async () => {
    const user = userEvent.setup();
    render(<StageChart byStage={BY_STAGE} />);
    await screen.findByTestId("bars");
    const chips = screen.getByRole("navigation", { name: "Open a stage in the list" });
    expect(
      within(chips)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/app/opportunities?view=list&stage=new",
      "/app/opportunities?view=list&stage=qualified",
      "/app/opportunities?view=list&stage=proposal",
      "/app/opportunities?view=list&stage=negotiation",
      "/app/opportunities?view=list&stage=won",
      "/app/opportunities?view=list&stage=lost",
    ]);
    expect(within(chips).getByRole("link", { name: "Negotiation (3)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View as table" }));
    const table = screen.getByRole("table", { name: /Opportunities by stage/ });
    expect(within(table).getByRole("link", { name: /^Won/ })).toHaveAttribute(
      "href",
      "/app/opportunities?view=list&stage=won",
    );
  });

  it("with no opportunities there is no chart, no table and no toggle: just a sentence", () => {
    render(<StageChart byStage={ZERO} />);
    expect(screen.getByText(/No opportunities yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("bars")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("animates when reduced motion is not requested", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    render(<StageChart byStage={BY_STAGE} />);
    await waitFor(async () =>
      expect(await screen.findByTestId("bars")).toHaveAttribute("data-animate", "true"),
    );
  });
});

const ME = "00000000-0000-4000-8000-0000000000aa";
const TOM = "00000000-0000-4000-8000-0000000000bb";
const event = (
  n: number,
  over: Partial<React.ComponentProps<typeof RecentActivity>["events"][number]> = {},
) => ({
  id: `e${n}`,
  entityType: "customer" as const,
  entityId: `c${n}`,
  action: "updated",
  summary: `Event ${n} happened`,
  actorUserId: ME,
  createdAt: `2026-11-0${(n % 9) + 1}T15:30:00.000Z`,
  changes: [],
  contentChanged: [],
  ...over,
});
function renderActivity(events: React.ComponentProps<typeof RecentActivity>["events"]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ userId: TOM, role: "member", displayName: "Tom Teammate" }],
          meta: {},
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
  );
  return render(
    <ApiClientProvider organizationId="org-1">
      <RecentActivity events={events} currentUserId={ME} timeZone="UTC" />
    </ApiClientProvider>,
  );
}

describe("RecentActivity [SIT-256]", () => {
  it("lists events with who did them (You, a teammate by name, System), the full timestamp, and links to the record", async () => {
    const { container } = renderActivity([
      event(1),
      event(2, {
        actorUserId: TOM,
        entityType: "opportunity",
        entityId: "o2",
        summary: "Tom moved opportunity X",
      }),
      event(3, { actorUserId: null, entityType: "task", summary: "System completed task T" }),
      event(4, { entityType: "quote", summary: "Quote sent" }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(items[0]).getByRole("link", { name: "Event 1 happened" })).toHaveAttribute(
      "href",
      "/app/customers/c1",
    );
    expect(within(items[0]).getByText(/By You/)).toBeInTheDocument();
    expect(within(items[1]).getByRole("link")).toHaveAttribute("href", "/app/opportunities/o2");
    await waitFor(() => expect(within(items[1]).getByText(/By Tom Teammate/)).toBeInTheDocument());
    expect(within(items[2]).getByText(/By System/)).toBeInTheDocument();
    expect(within(items[2]).getByRole("link")).toHaveAttribute("href", "/app/tasks");
    expect(within(items[3]).queryByRole("link")).toBeNull(); // quotes have no page yet
    const time = within(items[0]).getByText("7 days ago").closest("time")!;
    expect(time).toHaveAttribute("datetime", "2026-11-02T15:30:00.000Z");
    expect(time).toHaveAttribute("title", "Nov 2, 2026, 3:30 PM");
    expect(within(items[0]).getByText("(Nov 2, 2026, 3:30 PM)")).toBeInTheDocument(); // the full timestamp for screen readers
    expect(screen.getByRole("link", { name: /View all/ })).toHaveAttribute("href", "/app/activity");
    await expectNoA11yViolations(container);
  });

  it("an empty workspace gets a sentence, not an empty list", () => {
    renderActivity([]);
    expect(screen.getByText(/Nothing has happened in this workspace yet/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
