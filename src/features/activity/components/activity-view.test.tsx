import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { ActivityItemDto } from "../service";
import { ActivityView } from "./activity-view";

let search = "";
const replace = vi.fn((url: string) => {
  search = url.includes("?") ? url.split("?")[1] : "";
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: replace }),
  usePathname: () => "/app/activity",
  useSearchParams: () => new URLSearchParams(search),
}));

const ME = "00000000-0000-4000-8000-0000000000aa";
const TOM = "00000000-0000-4000-8000-0000000000bb";
const ev = (n: number, over: Partial<ActivityItemDto> = {}): ActivityItemDto => ({
  id: `e${n}`,
  entityType: "customer",
  entityId: `c${n}`,
  entityState: "active",
  action: "updated",
  summary: `Event ${n}`,
  actorUserId: TOM,
  actorName: "Tom Teammate",
  changes: [],
  contentChanged: [],
  createdAt: "2026-11-09T09:00:00.000Z",
  ...over,
});
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: URL[];
let respond: (url: URL) => Response;
const page = (items: ActivityItemDto[], total = items.length) =>
  json(200, {
    data: items,
    meta: { page: 1, limit: 25, total, totalPages: Math.max(1, Math.ceil(total / 25)) },
  });
const view = () =>
  render(
    <ApiClientProvider organizationId="org-1">
      <ActivityView currentUserId={ME} timeZone="UTC" />
    </ApiClientProvider>,
  );

beforeEach(() => {
  search = "";
  calls = [];
  replace.mockClear();
  respond = () =>
    page([
      ev(1),
      ev(2, { actorUserId: ME, actorName: "Me", entityState: "archived" }),
      ev(3, { actorUserId: null, actorName: "System", entityState: "missing" }),
    ]);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u) => {
    const url = new URL(String(u), "http://localhost");
    if (url.pathname.endsWith("/members"))
      return json(200, {
        data: [
          { userId: TOM, role: "member", displayName: "Tom Teammate" },
          { userId: ME, role: "owner", displayName: "Olive Owner" },
        ],
        meta: {},
      });
    calls.push(url);
    return respond(url);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("ActivityView [SIT-257]", () => {
  it("shows the feed: actors (You for the viewer), links by record state, and a page summary", async () => {
    const { container } = view();
    const list = await screen.findByRole("list", { name: "Activity" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByRole("link", { name: "Event 1" })).toHaveAttribute(
      "href",
      "/app/customers/c1",
    );
    expect(within(items[1]).getByText(/By You/)).toBeInTheDocument();
    expect(within(items[1]).getByText("Archived")).toBeInTheDocument();
    expect(within(items[2]).queryByRole("link")).toBeNull();
    expect(within(items[2]).getByText(/By System/)).toBeInTheDocument();
    expect(screen.getByText("Showing 1 to 3 of 3")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("filters are written to the URL (and reset to page 1)", async () => {
    const user = userEvent.setup();
    search = "page=2";
    respond = () => page([ev(1)], 60);
    view();
    await screen.findByRole("list", { name: "Activity" });
    await user.selectOptions(screen.getByLabelText("Records"), "task");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringMatching(/entityType=task/),
      expect.anything(),
    );
    expect(replace.mock.calls.at(-1)![0]).not.toContain("page=2");
    await user.selectOptions(screen.getByLabelText("What happened"), "stage_changed");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("action=stage_changed"),
      expect.anything(),
    );
    await user.selectOptions(screen.getByLabelText("Who"), "system");
    expect(replace).toHaveBeenLastCalledWith(
      expect.stringContaining("actor=system"),
      expect.anything(),
    );
    expect(
      within(screen.getByLabelText("Who")).getByRole("option", { name: "Olive Owner (you)" }),
    ).toBeInTheDocument();
  });

  it("the URL drives the request: filters and page reach the API, a bad date does not", async () => {
    search = `entityType=opportunity&action=stage_changed&actor=${TOM}&from=2026-10-01&to=bad&page=2&limit=10`;
    respond = () => page([ev(1)], 60);
    view();
    await screen.findByRole("list", { name: "Activity" });
    const sent = Object.fromEntries(calls.at(-1)!.searchParams);
    expect(sent).toMatchObject({
      entityType: "opportunity",
      action: "stage_changed",
      actor: TOM,
      from: "2026-10-01",
      page: "2",
      limit: "10",
    });
    expect(sent.to).toBeUndefined();
    expect(screen.getByLabelText("Records")).toHaveValue("opportunity");
    expect(screen.getByLabelText("From")).toHaveValue("2026-10-01");
  });

  it("paging buttons go through the URL", async () => {
    const user = userEvent.setup();
    respond = () => page([ev(1)], 60);
    view();
    await screen.findByRole("list", { name: "Activity" });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining("page=2"), expect.anything());
  });

  it("empty workspace: 'No activity yet'; with filters on: 'No activity matches' and Clear filters resets", async () => {
    respond = () => page([], 0);
    const first = view();
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    first.unmount();
    search = "action=archived";
    const user = userEvent.setup();
    view();
    expect(await screen.findByText("No activity matches")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(replace).toHaveBeenLastCalledWith(
      expect.not.stringContaining("action="),
      expect.anything(),
    );
  });

  it("a page past the end offers the first page", async () => {
    search = "page=9";
    respond = () => json(200, { data: [], meta: { page: 9, limit: 25, total: 5, totalPages: 1 } });
    view();
    expect(await screen.findByText("There is no activity on this page")).toBeInTheDocument();
  });

  it("loading status first; an error shows the request id and a retry that recovers", async () => {
    respond = () =>
      json(404, { error: { code: "NOT_FOUND", message: "Nope", requestId: "req-7" } });
    const user = userEvent.setup();
    view();
    expect(screen.getByRole("status")).toHaveTextContent("Loading activity");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Activity could not be loaded");
    expect(alert).toHaveTextContent("req-7");
    respond = () => page([ev(1)]);
    await user.click(within(alert).getByRole("button", { name: /Try again|Retry/ }));
    await waitFor(() => expect(screen.getByRole("list", { name: "Activity" })).toBeInTheDocument());
  });
});
