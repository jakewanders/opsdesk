import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "../schema";
import { OpportunityDetail } from "./opportunity-detail";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const NOW = "2026-11-02T10:00:00.000000+00:00";
const deal: OpportunityDto = {
  id: "d0000000-0000-4000-8000-000000000001",
  customerId: "c0000000-0000-4000-8000-000000000001",
  customerName: "Acme Plumbing",
  title: "Warehouse retrofit",
  description: "Scope agreed.\n<script>alert(1)</script>",
  stage: "proposal",
  amountCents: 123450,
  probabilityPercent: 50,
  expectedCloseDate: "2026-12-01",
  assignedTo: ME,
  lostReason: null,
  closedAt: null,
  createdBy: ME,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let current: OpportunityDto;
let posts: Array<Record<string, unknown>>;
let failNext: Response | null;

function installApi() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [{ userId: ME, role: "owner", displayName: "Olivia Owner" }],
        meta: {},
      });
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (failNext) {
        const r = failNext;
        failNext = null;
        return r;
      }
      current = {
        ...current,
        stage: body.stage,
        probabilityPercent: {
          new: 10,
          qualified: 25,
          proposal: 50,
          negotiation: 75,
          won: 100,
          lost: 0,
        }[body.stage as string]!,
        lostReason: body.stage === "lost" ? body.lostReason : null,
        closedAt: body.stage === "won" || body.stage === "lost" ? NOW : null,
        updatedAt: "2026-11-02T11:00:00.000000+00:00",
      };
      return json(200, { data: current, meta: {} });
    }
    return json(200, { data: current, meta: {} });
  });
}
const renderDetail = (canWrite = true, initial = deal) => {
  current = initial;
  return render(
    <ApiClientProvider organizationId="org-1">
      <OpportunityDetail initial={initial} canWrite={canWrite} />
    </ApiClientProvider>,
  );
};

beforeEach(() => {
  posts = [];
  failNext = null;
  notify.error.mockClear();
  notify.success.mockClear();
  installApi();
});
afterEach(() => vi.restoreAllMocks());

describe("OpportunityDetail", () => {
  it("shows the stage as an icon and a word, the amount, the weighted value (rounded per deal), owner and dates", async () => {
    renderDetail();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Warehouse retrofit");
    expect(screen.getByRole("link", { name: "Acme Plumbing" })).toHaveAttribute(
      "href",
      "/app/customers/c0000000-0000-4000-8000-000000000001",
    );
    const dl = screen.getByText("Amount").closest("dl")!;
    expect(dl).toHaveTextContent("Amount$1,234.50");
    expect(dl).toHaveTextContent("Probability50%");
    expect(dl).toHaveTextContent("Weighted value$617.25"); // 123450 * 50 / 100
    expect(dl).toHaveTextContent("Expected close dateDec 1, 2026");
    await waitFor(() => expect(dl).toHaveTextContent("OwnerOlivia Owner"));
    expect(screen.getAllByText("Proposal").length).toBeGreaterThan(0);
  });
  it("renders the description as text, never as markup", () => {
    const { container } = renderDetail();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  });
  it("a closed deal is out of the open pipeline and shows its close date and the lost reason", () => {
    renderDetail(true, {
      ...deal,
      stage: "lost",
      probabilityPercent: 0,
      closedAt: NOW,
      lostReason: "Chose a competitor",
    });
    expect(screen.getByText("Not in the open pipeline")).toBeInTheDocument();
    expect(screen.getByText("Chose a competitor")).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });
  it("changing the stage posts it with the version seen, shows the new stage and probability, and says so", async () => {
    renderDetail();
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "negotiation");
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Moved to Negotiation", "Warehouse retrofit"),
    );
    expect(posts[0]).toEqual({ stage: "negotiation", lostReason: null, expectedUpdatedAt: NOW });
    await waitFor(() =>
      expect(screen.getByText("Probability").parentElement).toHaveTextContent("75%"),
    );
    expect((screen.getByLabelText("Stage") as HTMLSelectElement).value).toBe("negotiation");
  });
  it("Lost asks for a reason: empty is refused at the field, a reason is sent trimmed, Cancel changes nothing", async () => {
    renderDetail();
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "lost");
    let dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    expect(within(dialog).getByLabelText(/Why was this deal lost/)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(posts).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toHaveLength(0);
    expect((screen.getByLabelText("Stage") as HTMLSelectElement).value).toBe("proposal");
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "lost");
    dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText(/Why was this deal lost/),
      "  Too expensive ",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as lost" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({ stage: "lost", lostReason: "Too expensive" });
    expect(await screen.findByText("Why it was lost")).toBeInTheDocument();
  });
  it.each([
    [
      409,
      {
        code: "STALE_EDIT",
        message: "changed",
        requestId: "r",
        meta: { current: { updatedAt: "x" } },
      },
      /Someone else changed/,
    ],
    [403, { code: "FORBIDDEN", message: "no", requestId: "r" }, /permission/],
    [
      422,
      { code: "VALIDATION_ERROR", message: "Say why this deal was lost.", requestId: "r" },
      /Say why/,
    ],
  ])(
    "a refused move (%s) shows a message and leaves the stage as it was",
    async (status, error, message) => {
      renderDetail();
      failNext = json(status, { error });
      await userEvent.selectOptions(screen.getByLabelText("Stage"), "won");
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      await waitFor(() =>
        expect((screen.getByLabelText("Stage") as HTMLSelectElement).value).toBe("proposal"),
      );
      expect(notify.success).not.toHaveBeenCalled();
    },
  );
  it("a viewer sees the deal and no Edit button or stage control", () => {
    renderDetail(false);
    expect(screen.queryByLabelText("Stage")).toBeNull();
    expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("link", { name: "Back to pipeline" })).toBeInTheDocument();
  });
  it("an owner can edit: the Edit link goes to the edit page", () => {
    renderDetail();
    expect(screen.getByRole("link", { name: "Edit" })).toHaveAttribute(
      "href",
      `/app/opportunities/${deal.id}/edit`,
    );
  });
  it("has no axe violations, including with the Lost dialog open", async () => {
    const { container } = renderDetail();
    await expectNoA11yViolations(container);
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "lost");
    await screen.findByRole("dialog");
    await expectNoA11yViolations(document.body);
  });
});
