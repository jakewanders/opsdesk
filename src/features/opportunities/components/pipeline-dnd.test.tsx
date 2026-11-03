import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import {
  DEFAULT_PROBABILITY,
  STAGES,
  pipelineTotal,
  totalsByStage,
  weightedPipeline,
  type Stage,
} from "@/lib/domain/pipeline";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "../schema";
import { announcements, stageCoordinateGetter } from "./board-dnd";
import { PipelineBoard } from "./pipeline-board";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/opportunities",
  useSearchParams: () => new URLSearchParams(),
}));

const ME = "00000000-0000-4000-8000-0000000000aa";
const NOW = "2026-11-02T10:00:00.000000+00:00";
const mk = (id: string, title: string, stage: Stage, amountCents: number): OpportunityDto => ({
  id,
  customerId: "c1",
  customerName: "Acme Plumbing",
  customerArchived: false,
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
});
const FIXTURE = () => [
  mk("d1", "Alpha retrofit", "new", 100001),
  mk("d2", "Beta boiler", "qualified", 250003),
  mk("d3", "Gamma roof", "proposal", 750000),
  mk("d4", "Delta kitchen", "negotiation", 1250007),
];

let deals: OpportunityDto[];
let posts: Array<Record<string, unknown>>;
let failNext: { status: number; error: Record<string, unknown> } | null;
let hangReads = false;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const metaOf = (list: OpportunityDto[]) => {
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
};
function installApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [{ userId: ME, role: "owner", displayName: "Olivia Owner" }],
        meta: {},
      });
    if (init?.method === "POST" && url.pathname.endsWith("/stage")) {
      const id = url.pathname.split("/").at(-2)!;
      const body = JSON.parse(String(init.body));
      posts.push({ id, ...body });
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
              lostReason: body.lostReason ?? null,
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

// jsdom has no layout: give each stage column a rectangle (300px apart) and everything inside a column a small one inside it.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.getBoundingClientRect = function (this: Element) {
    // dnd-kit positions its overlay with inline fixed-position styles copied from the dragged node: use them as they are
    const style = (this as HTMLElement).style;
    if (style?.position === "fixed" && style.left) {
      const [left, top, width, height] = [style.left, style.top, style.width, style.height].map(
        (v) => parseFloat(v) || 0,
      );
      return {
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({}),
      } as DOMRect;
    }
    // the drag overlay lives outside the columns: place it over the column of the focused handle that is being dragged
    const col =
      this.closest("[data-stage]") ?? document.activeElement?.closest("[data-stage]") ?? null;
    const index = col ? STAGES.indexOf(col.getAttribute("data-stage") as Stage) : 0;
    const isColumn = this.hasAttribute("data-stage");
    const left = index * 300 + (isColumn ? 0 : 10);
    const top = isColumn ? 0 : 100;
    const width = isColumn ? 280 : 100;
    const height = isColumn ? 800 : 40;
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const renderBoard = (canWrite = true) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <PipelineBoard canWrite={canWrite} currentUserId={ME} />
    </ApiClientProvider>,
  );
const column = (label: string) => screen.getByRole("region", { name: label }) as HTMLElement;
const header = (label: string) =>
  within(column(label)).getByRole("heading", { level: 2 }).parentElement!.textContent;
const live = () => document.querySelector('[aria-live="assertive"]')!.textContent ?? "";
const handle = (title: string) => screen.getByRole("button", { name: `Drag ${title}` });
const loaded = () =>
  waitFor(() => expect(within(column("Qualified")).getByText("Beta boiler")).toBeInTheDocument());

async function liftAndMove(title: string, arrows: number, drop = true) {
  const user = userEvent.setup();
  handle(title).focus();
  await user.keyboard(" ");
  for (let i = 0; i < arrows; i++) await user.keyboard("{ArrowRight}");
  if (drop) await user.keyboard(" ");
  return user;
}

beforeEach(() => {
  deals = FIXTURE();
  posts = [];
  failNext = null;
  hangReads = false;
  notify.error.mockClear();
  installApi();
});
afterEach(() => vi.restoreAllMocks());

describe("PipelineBoard drag and drop: keyboard", () => {
  it("lift with Space, Right twice, drop with Space: announces each step, calls the stage endpoint (never PATCH) and sets probability 75 and the totals", async () => {
    renderBoard();
    await loaded();
    const user = userEvent.setup();
    handle("Beta boiler").focus();
    await user.keyboard(" ");
    // the pick-up announcement (with its instructions) is what the live region holds: the redundant same-tick "over its own
    // column" is skipped so it cannot replace it (SIT-261)
    expect(live()).toBe(
      "Picked up Beta boiler. It is in Qualified. Use the left and right arrow keys to choose a stage.",
    );
    await user.keyboard("{ArrowRight}");
    expect(live()).toBe("Beta boiler is over Proposal.");
    await user.keyboard("{ArrowRight}");
    expect(live()).toBe("Beta boiler is over Negotiation.");
    await user.keyboard(" ");
    expect(live()).toBe("Dropped Beta boiler on Negotiation.");
    // immediately: card, probability, counts and totals
    const moved = within(column("Negotiation")).getByText("Beta boiler").closest("article")!;
    expect(moved).toHaveTextContent("75%");
    expect(header("Qualified")).toBe("Qualified0 deals · $0");
    expect(header("Negotiation")).toBe("Negotiation2 deals · $15,000");
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      id: "d2",
      stage: "negotiation",
      lostReason: null,
      expectedUpdatedAt: NOW,
    });
    const rows = deals.map((d) => ({
      stage: d.stage,
      amountCents: d.amountCents,
      probability: d.probabilityPercent,
    }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Pipeline totals" })).toHaveTextContent(
        `$${(weightedPipeline(rows) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      ),
    );
  });
  it("Escape cancels: nothing moves, nothing is sent, and the cancellation is announced", async () => {
    renderBoard();
    await loaded();
    const user = userEvent.setup();
    handle("Beta boiler").focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}");
    await user.keyboard("{Escape}");
    expect(live()).toBe("Move cancelled. Beta boiler stays in Qualified.");
    expect(posts).toHaveLength(0);
    expect(within(column("Qualified")).getByText("Beta boiler")).toBeInTheDocument();
  });
  it("dropping where it started sends nothing", async () => {
    renderBoard();
    await loaded();
    const user = userEvent.setup();
    handle("Beta boiler").focus();
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(live()).toMatch(/was not moved/);
    expect(posts).toHaveLength(0);
  });
  it("Left and Right stop at the first and last stage (no wrap, no error)", async () => {
    renderBoard();
    await loaded();
    const user = userEvent.setup();
    handle("Alpha retrofit").focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowLeft}");
    await user.keyboard(" ");
    expect(posts).toHaveLength(0);
    expect(within(column("New")).getByText("Alpha retrofit")).toBeInTheDocument();
  });
  it("a keyboard-only user can take a card through every stage: New to Qualified to Proposal to Negotiation to Won (confirmed) and then to Lost (with a reason)", async () => {
    renderBoard();
    await loaded();
    const user = userEvent.setup();
    const step = async () => {
      handle("Alpha retrofit").focus();
      await user.keyboard(" ");
      await user.keyboard("{ArrowRight}");
      await user.keyboard(" ");
    };
    for (const expected of ["qualified", "proposal", "negotiation"]) {
      await step();
      await waitFor(() => expect(posts.at(-1)?.stage).toBe(expected));
      await waitFor(() =>
        expect(
          within(column(expected[0].toUpperCase() + expected.slice(1))).getByText("Alpha retrofit"),
        ).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Drag Alpha retrofit" })).not.toBeDisabled(),
      );
    }
    await step(); // to Won: asks first
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Mark as won?");
    expect(posts).toHaveLength(3);
    await user.click(within(confirm).getByRole("button", { name: "Mark as won" }));
    await waitFor(() => expect(posts.at(-1)?.stage).toBe("won"));
    await waitFor(() =>
      expect(within(column("Won")).getByText("Alpha retrofit")).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Drag Alpha retrofit" })).not.toBeDisabled(),
    );
    await step(); // to Lost: asks for a reason
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Why was this deal lost/), "Budget cut");
    await user.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    await waitFor(() =>
      expect(posts.at(-1)).toMatchObject({ stage: "lost", lostReason: "Budget cut" }),
    );
    await waitFor(() =>
      expect(within(column("Lost")).getByText("Alpha retrofit")).toBeInTheDocument(),
    );
    expect(posts.map((p) => p.stage)).toEqual([
      "qualified",
      "proposal",
      "negotiation",
      "won",
      "lost",
    ]);
  });
});

describe("PipelineBoard drag and drop: Won and Lost dialogs", () => {
  it("a drop on Won asks first with the close date; Cancel leaves the card where it was and sends nothing", async () => {
    renderBoard();
    await loaded();
    const user = await liftAndMove("Delta kitchen", 1);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delta kitchen");
    expect(dialog).toHaveTextContent(/closes today \(/);
    expect(dialog).toHaveTextContent("probability becomes 100%");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(posts).toHaveLength(0);
    expect(within(column("Negotiation")).getByText("Delta kitchen")).toBeInTheDocument();
    expect(header("Negotiation")).toBe("Negotiation1 deal · $12,500");
  });
  it("confirming Won sends the move once", async () => {
    renderBoard();
    await loaded();
    const user = await liftAndMove("Delta kitchen", 1);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Mark as won" }),
    );
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ id: "d4", stage: "won", lostReason: null });
    await waitFor(() =>
      expect(within(column("Won")).getByText("Delta kitchen")).toBeInTheDocument(),
    );
  });
  it("a drop on Lost requires a reason (refused empty, at the field); Cancel moves nothing; a reason is sent", async () => {
    renderBoard();
    await loaded();
    const user = await liftAndMove("Delta kitchen", 2);
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    expect(within(dialog).getByLabelText(/Why was this deal lost/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(posts).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(posts).toHaveLength(0);
    expect(within(column("Negotiation")).getByText("Delta kitchen")).toBeInTheDocument();
    await liftAndMove("Delta kitchen", 2);
    dialog = await screen.findByRole("dialog");
    await user.type(
      within(dialog).getByLabelText(/Why was this deal lost/),
      "  Went with a rival ",
    );
    await user.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ stage: "lost", lostReason: "Went with a rival" });
  });
});

describe("PipelineBoard drag and drop: failures roll back", () => {
  it.each([
    [
      409,
      { code: "STALE_EDIT", message: "changed", meta: { current: { updatedAt: "x" } } },
      /Someone else changed it/,
    ],
    [403, { code: "FORBIDDEN", message: "no" }, /permission/],
    [429, { code: "RATE_LIMITED", message: "slow down" }, /too quickly/],
    [422, { code: "VALIDATION_ERROR", message: "Say why this deal was lost." }, /Say why/],
  ])(
    "a refused drop (%s) puts the card, counts, probability and totals back, with an actionable message",
    async (status, error, message) => {
      renderBoard();
      await loaded();
      const bar = screen.getByRole("region", { name: "Pipeline totals" }).textContent;
      const qualified = header("Qualified");
      failNext = { status, error };
      await liftAndMove("Beta boiler", 2);
      await waitFor(() => expect(notify.error).toHaveBeenCalledTimes(1));
      expect(notify.error.mock.calls[0][1]).toMatch(message);
      await waitFor(() =>
        expect(within(column("Qualified")).getByText("Beta boiler")).toBeInTheDocument(),
      );
      expect(within(column("Negotiation")).queryByText("Beta boiler")).toBeNull();
      expect(header("Qualified")).toBe(qualified);
      expect(screen.getByRole("region", { name: "Pipeline totals" }).textContent).toBe(bar);
      expect(
        within(column("Qualified")).getByText("Beta boiler").closest("article"),
      ).toHaveTextContent("25%");
    },
  );
});

describe("PipelineBoard drag and drop: pointer, menu and roles", () => {
  it("a mouse drag of the handle to another column moves the card (and a tiny wiggle does not)", async () => {
    renderBoard();
    await loaded();
    const h = handle("Beta boiler");
    h.focus();
    fireEvent.mouseDown(h, { button: 0, clientX: 310, clientY: 120 });
    fireEvent.mouseMove(document, { clientX: 312, clientY: 121 });
    fireEvent.mouseUp(document, { clientX: 312, clientY: 121 });
    expect(posts).toHaveLength(0);
    fireEvent.mouseDown(h, { button: 0, clientX: 310, clientY: 120 });
    fireEvent.mouseMove(document, { clientX: 620, clientY: 125 });
    fireEvent.mouseMove(document, { clientX: 910, clientY: 125 });
    fireEvent.mouseUp(document, { clientX: 910, clientY: 125 });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ id: "d2", stage: "negotiation" });
  });
  it("the stage menu still works without any drag", async () => {
    renderBoard();
    await loaded();
    await userEvent.selectOptions(
      screen.getByLabelText("Move Beta boiler to another stage"),
      "proposal",
    );
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ stage: "proposal" });
  });
  it("a viewer has no drag handles and no menus", async () => {
    renderBoard(false);
    await loaded();
    expect(screen.queryAllByRole("button", { name: /^Drag / })).toHaveLength(0);
    expect(screen.queryAllByRole("combobox", { name: /Move .* to another stage/ })).toHaveLength(0);
  });
  it("has no axe violations with a drag handle focused, and while a card is lifted", async () => {
    const { container } = renderBoard();
    await loaded();
    handle("Beta boiler").focus();
    await expectNoA11yViolations(container);
    const user = userEvent.setup();
    await user.keyboard(" ");
    await user.keyboard("{ArrowRight}");
    await expectNoA11yViolations(document.body);
    await user.keyboard("{Escape}");
  });
});

describe("announcements (what a screen reader is told)", () => {
  const args = (deal: OpportunityDto, overId?: string) =>
    ({
      active: { id: deal.id, data: { current: { deal } } },
      over: overId ? { id: overId } : null,
    }) as never;
  const beta = mk("d2", "Beta boiler", "qualified", 250003);
  it("pick up, over, drop and cancel each say the deal and the stage in words", () => {
    expect(announcements.onDragStart!(args(beta))).toBe(
      "Picked up Beta boiler. It is in Qualified. Use the left and right arrow keys to choose a stage.",
    );
    expect(announcements.onDragOver!(args(beta, "proposal"))).toBe("Beta boiler is over Proposal.");
    expect(announcements.onDragOver!(args(beta))).toBe("Beta boiler is not over a stage.");
    expect(announcements.onDragEnd!(args(beta, "negotiation"))).toBe(
      "Dropped Beta boiler on Negotiation.",
    );
    expect(announcements.onDragEnd!(args(beta, "qualified"))).toBe(
      "Beta boiler was not moved. It stays in Qualified.",
    );
    expect(announcements.onDragEnd!(args(beta))).toBe(
      "Beta boiler was not moved. It stays in Qualified.",
    );
    expect(announcements.onDragCancel!(args(beta))).toBe(
      "Move cancelled. Beta boiler stays in Qualified.",
    );
  });
  it("the keyboard getter only reacts to Left and Right and never leaves the six stages", () => {
    const rects = new Map(
      STAGES.map((s, i) => [s, { left: i * 300, top: 0, width: 280, height: 800 }]),
    );
    const call = (code: string, from: Stage) =>
      stageCoordinateGetter(
        { code, preventDefault() {} } as never,
        {
          context: {
            active: { data: { current: { deal: mk("x", "X", from, 1) } } },
            droppableRects: rects,
            over: null,
          },
        } as never,
      );
    expect(call("ArrowRight", "qualified")).toEqual({ x: 608, y: 8 });
    expect(call("ArrowLeft", "qualified")).toEqual({ x: 8, y: 8 });
    expect(call("ArrowRight", "lost")).toBeUndefined();
    expect(call("ArrowLeft", "new")).toBeUndefined();
    expect(call("ArrowDown", "qualified")).toBeUndefined();
    expect(call("Tab", "qualified")).toBeUndefined();
  });
});
