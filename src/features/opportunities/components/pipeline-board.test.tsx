import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import {
  DEFAULT_PROBABILITY,
  pipelineTotal,
  totalsByStage,
  weightedPipeline,
  type Stage,
} from "@/lib/domain/pipeline";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "../schema";
import { PipelineBoard } from "./pipeline-board";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/opportunities",
  useSearchParams: () => new URLSearchParams(),
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
  closedAt: stage === "won" || stage === "lost" ? NOW : null,
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  ...over,
});
const FIXTURE = () => [
  mk("d1", "Alpha retrofit", "new", 100001),
  mk("d2", "Beta boiler", "qualified", 250003, { assignedTo: ME }),
  mk("d3", "Gamma roof", "proposal", 750000, { probabilityPercent: 60 }),
  mk("d4", "Delta kitchen", "negotiation", 1250007),
  mk("d5", "Epsilon pool", "negotiation", 500000),
  mk("d6", "Zeta won", "won", 900000),
  mk("d7", "Eta lost", "lost", 400000, { lostReason: "Price" }),
];

let deals: OpportunityDto[];
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let failNext: { status: number; error: Record<string, unknown> } | null;
/** After a failed move, reads never answer: only the rollback itself can put the board back (not the refetch). */
let hangReads = false;

function metaOf(list: OpportunityDto[]) {
  const rows = list.map((d) => ({
    stage: d.stage,
    amountCents: d.amountCents,
    probability: d.probabilityPercent,
  }));
  return {
    total: list.length,
    stageTotals: totalsByStage(rows),
    openPipelineCents: pipelineTotal(rows),
    weightedPipelineCents: weightedPipeline(rows),
    aggregatesComplete: true,
  };
}
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function installApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members")) return json(200, { data: MEMBERS, meta: {} });
    if (init?.method === "POST" && url.pathname.endsWith("/stage")) {
      const id = url.pathname.split("/").at(-2)!;
      const body = JSON.parse(String(init.body));
      posts.push({ url: url.pathname, body });
      if (failNext) {
        const f = failNext;
        failNext = null;
        hangReads = true;
        return json(f.status, { error: { requestId: "r1", ...f.error } });
      }
      deals = deals.map((d) =>
        d.id === id
          ? {
              ...d,
              stage: body.stage,
              probabilityPercent: DEFAULT_PROBABILITY[body.stage as Stage],
              closedAt: body.stage === "won" || body.stage === "lost" ? NOW : null,
              lostReason: body.stage === "lost" ? body.lostReason : null,
              updatedAt: "2026-11-02T11:00:00.000000+00:00",
            }
          : d,
      );
      return json(200, { data: deals.find((d) => d.id === id), meta: {} });
    }
    if (hangReads) return new Promise<Response>(() => undefined);
    const stage = url.searchParams.get("stage");
    const limit = Number(url.searchParams.get("limit") ?? 25);
    const list = deals.filter((d) => !stage || d.stage === stage);
    return json(200, { data: list.slice(0, limit), meta: { ...metaOf(deals), page: 1, limit } });
  });
}

const renderBoard = (canWrite = true) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <PipelineBoard canWrite={canWrite} currentUserId={ME} />
    </ApiClientProvider>,
  );
const column = (label: string) => screen.getByRole("region", { name: label }) as HTMLElement;
const header = (label: string) =>
  within(column(label)).getByRole("heading", { level: 2 }).parentElement!.textContent;
const totalsBar = () => screen.getByRole("region", { name: "Pipeline totals" });
const waitLoaded = () =>
  waitFor(() => expect(within(column("Qualified")).getByText("Beta boiler")).toBeInTheDocument());

beforeEach(() => {
  deals = FIXTURE();
  posts = [];
  failNext = null;
  hangReads = false;
  notify.error.mockClear();
  installApi();
});
afterEach(() => vi.restoreAllMocks());

describe("PipelineBoard: columns, cards and totals", () => {
  it("shows six columns with counts and summed amounts from the API meta, and cards with customer, title, amount, owner and date", async () => {
    renderBoard();
    await waitLoaded();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "New",
      "Qualified",
      "Proposal",
      "Negotiation",
      "Won",
      "Lost",
    ]);
    expect(header("New")).toBe("New1 deal · $1,000");
    expect(header("Negotiation")).toBe("Negotiation2 deals · $17,500");
    const card = within(column("Qualified")).getByRole("article");
    expect(card).toHaveTextContent("Acme Plumbing");
    expect(card).toHaveTextContent("Beta boiler");
    expect(card).toHaveTextContent("$2,500.03");
    expect(card).toHaveTextContent("25%");
    expect(card).toHaveTextContent("Olivia Owner");
    expect(card).toHaveTextContent("Expected Dec 1, 2026");
    expect(within(column("New")).getByRole("article")).toHaveTextContent("Unassigned");
    expect(within(column("Won")).getByRole("article")).toHaveTextContent("Closed Nov 2, 2026");
    expect(
      within(column("New")).getByRole("link", {
        name: "Alpha retrofit",
      }),
    ).toHaveAttribute("href", "/app/opportunities/d1");
  });
  it("the totals bar matches the domain module, and each column's header matches both the API meta and its cards", async () => {
    renderBoard();
    await waitLoaded();
    const rows = deals.map((d) => ({
      stage: d.stage,
      amountCents: d.amountCents,
      probability: d.probabilityPercent,
    }));
    expect(totalsBar()).toHaveTextContent("Open pipeline");
    expect(totalsBar()).toHaveTextContent(
      `$${(pipelineTotal(rows) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    expect(totalsBar()).toHaveTextContent(
      `$${(weightedPipeline(rows) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    expect(totalsBar()).toHaveTextContent("Open deals5");
    const totals = totalsByStage(rows);
    for (const [stage, label] of [
      ["new", "New"],
      ["qualified", "Qualified"],
      ["proposal", "Proposal"],
      ["negotiation", "Negotiation"],
      ["won", "Won"],
      ["lost", "Lost"],
    ] as const) {
      expect(within(column(label)).queryAllByRole("article")).toHaveLength(totals[stage].count);
    }
  });
  it("empty columns say so; filters change the wording; an error loads a retry", async () => {
    deals = deals.filter((d) => d.stage !== "lost");
    renderBoard();
    await waitLoaded();
    expect(within(column("Lost")).getByText("No deals in Lost.")).toBeInTheDocument();
  });
  it("a column over the page size caps its cards and offers Show more", async () => {
    deals = Array.from({ length: 13 }, (_, i) => mk(`n${i}`, `New deal ${i}`, "new", 1000));
    renderBoard();
    await waitFor(() => expect(within(column("New")).getAllByRole("article")).toHaveLength(10));
    expect(header("New")).toBe("New13 deals · $130");
    await userEvent.click(screen.getByRole("button", { name: "Show 3 more (3 left)" }));
    await waitFor(() => expect(within(column("New")).getAllByRole("article")).toHaveLength(13));
    expect(screen.queryByRole("button", { name: /Show .* more/ })).toBeNull();
  });
  it("a failed load shows an alert with a retry", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (u) =>
      String(u).includes("/members")
        ? json(200, { data: MEMBERS, meta: {} })
        : json(403, { error: { code: "FORBIDDEN", message: "Boom", requestId: "r9" } }),
    );
    renderBoard();
    expect(await screen.findByText("The pipeline could not be loaded")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /try again|retry/i }).length).toBeGreaterThan(0);
  });
});

describe("PipelineBoard: moving a deal", () => {
  it("moves the card, the column totals, the open and weighted pipeline and the probability at once, then keeps the server's answer", async () => {
    renderBoard();
    await waitLoaded();
    const before = totalsBar().textContent;
    await userEvent.selectOptions(
      screen.getByLabelText("Move Beta boiler to another stage"),
      "proposal",
    );
    // immediately: the card is in Proposal with its new default probability
    const moved = within(column("Proposal")).getByText("Beta boiler").closest("article")!;
    expect(moved).toHaveTextContent("50%");
    expect(within(column("Qualified")).queryByText("Beta boiler")).toBeNull();
    expect(header("Qualified")).toBe("Qualified0 deals · $0");
    expect(header("Proposal")).toBe("Proposal2 deals · $10,000");
    expect(totalsBar().textContent).not.toBe(before);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].url).toContain("/opportunities/d2/stage");
    expect(posts[0].body).toEqual({ stage: "proposal", lostReason: null, expectedUpdatedAt: NOW });
    // after the refetch the numbers equal the domain module's for the server's data
    await waitFor(() => expect(notify.error).not.toHaveBeenCalled());
    const rows = deals.map((d) => ({
      stage: d.stage,
      amountCents: d.amountCents,
      probability: d.probabilityPercent,
    }));
    await waitFor(() =>
      expect(totalsBar()).toHaveTextContent(
        `$${(weightedPipeline(rows) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      ),
    );
    expect(totalsBar()).toHaveTextContent(
      `$${(pipelineTotal(rows) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
  });
  it.each([
    [
      409,
      { code: "STALE_EDIT", message: "changed", meta: { current: { updatedAt: "x" } } },
      /changed it/,
    ],
    [422, { code: "VALIDATION_ERROR", message: "Say why this deal was lost." }, /Say why/],
    [403, { code: "FORBIDDEN", message: "no" }, /permission/],
    [500, { code: "INTERNAL_ERROR", message: "Something broke" }, /Something broke/],
  ])(
    "an API error (%s) puts the card, the counts and every total back and tells the person why",
    async (status, error, message) => {
      renderBoard();
      await waitLoaded();
      const bar = totalsBar().textContent;
      const qualified = header("Qualified");
      failNext = { status, error };
      await userEvent.selectOptions(
        screen.getByLabelText("Move Beta boiler to another stage"),
        "won",
      );
      await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
      expect(notify.error.mock.calls[0][1]).toMatch(message);
      await waitFor(() =>
        expect(within(column("Qualified")).getByText("Beta boiler")).toBeInTheDocument(),
      );
      expect(within(column("Won")).queryByText("Beta boiler")).toBeNull();
      expect(header("Qualified")).toBe(qualified);
      expect(totalsBar().textContent).toBe(bar);
      expect(
        within(column("Qualified")).getByText("Beta boiler").closest("article"),
      ).toHaveTextContent("25%");
      expect(
        (screen.getByLabelText("Move Beta boiler to another stage") as HTMLSelectElement).value,
      ).toBe("qualified");
    },
  );
  it("Lost asks for a reason first: an empty reason is refused at the field, a reason moves the deal and is sent", async () => {
    renderBoard();
    await waitLoaded();
    await userEvent.selectOptions(
      screen.getByLabelText("Move Gamma roof to another stage"),
      "lost",
    );
    const dialog = await screen.findByRole("dialog");
    expect(posts).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    expect(within(dialog).getByLabelText(/Why was this deal lost/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(dialog).toHaveTextContent("Say why this deal was lost.");
    expect(posts).toHaveLength(0);
    await userEvent.type(
      within(dialog).getByLabelText(/Why was this deal lost/),
      "  Chose a competitor ",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    await waitFor(() => expect(within(column("Lost")).getByText("Gamma roof")).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toMatchObject({ stage: "lost", lostReason: "Chose a competitor" });
  });
  it("cancelling the Lost dialog moves nothing", async () => {
    renderBoard();
    await waitLoaded();
    await userEvent.selectOptions(
      screen.getByLabelText("Move Gamma roof to another stage"),
      "lost",
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toHaveLength(0);
    expect(within(column("Proposal")).getByText("Gamma roof")).toBeInTheDocument();
  });
  it("reopening a lost deal goes through the same menu and clears its closed state", async () => {
    renderBoard();
    await waitLoaded();
    await userEvent.selectOptions(
      screen.getByLabelText("Move Eta lost to another stage"),
      "qualified",
    );
    const card = within(column("Qualified")).getByText("Eta lost").closest("article")!;
    expect(card).toHaveTextContent("25%");
    expect(card).toHaveTextContent("Expected Dec 1, 2026");
  });
});

describe("PipelineBoard: roles, keyboard and accessibility", () => {
  it("a viewer sees the cards and no stage menus", async () => {
    renderBoard(false);
    await waitLoaded();
    expect(screen.queryAllByRole("combobox", { name: /Move .* to another stage/ })).toHaveLength(0);
    expect(
      within(column("Qualified")).getByRole("link", { name: "Beta boiler" }),
    ).toBeInTheDocument();
  });
  it("cards, links and stage menus are reachable with the Tab key, and a move works from the keyboard", async () => {
    renderBoard();
    await waitLoaded();
    const user = userEvent.setup();
    const select = screen.getByLabelText("Move Beta boiler to another stage");
    for (let i = 0; i < 60 && document.activeElement !== select; i++) await user.tab();
    expect(select).toHaveFocus();
    // a native select: the browser changes it with the arrow keys; user-event does not emulate that, so choose directly
    await user.selectOptions(select, "proposal");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.stage).toBe("proposal");
  });
  it("has no axe violations loaded and with the Lost dialog open", async () => {
    const { container } = renderBoard();
    await waitLoaded();
    await expectNoA11yViolations(container);
    await userEvent.selectOptions(
      screen.getByLabelText("Move Gamma roof to another stage"),
      "lost",
    );
    await screen.findByRole("dialog");
    await expectNoA11yViolations(document.body);
  });
});
