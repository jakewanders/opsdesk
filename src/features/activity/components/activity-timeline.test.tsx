import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "@/test/axe";
import { ActivityTimeline, type TimelineItem } from "./activity-timeline";

vi.mock("next/link", () => ({
  default: ({ children, ...p }: React.ComponentProps<"a">) => <a {...p}>{children}</a>,
}));

const NOW = new Date("2026-11-10T12:00:00.000Z");
const item = (n: number, over: Partial<TimelineItem> = {}): TimelineItem => ({
  id: `e${n}`,
  action: "updated",
  summary: `Olive updated customer "Acme ${n}"`,
  actorName: "Olive Owner",
  createdAt: "2026-11-09T09:00:00.000Z",
  changes: [],
  contentChanged: [],
  ...over,
});
const view = (items: TimelineItem[]) =>
  render(<ActivityTimeline items={items} timeZone="UTC" label="Activity" now={NOW} />);

describe("ActivityTimeline [SIT-257]", () => {
  it("is an ordered list: each item has the action as icon and word, the plain summary, the actor, and the time", () => {
    const { container } = view([
      item(1),
      item(2, {
        action: "stage_changed",
        summary: 'Olive moved opportunity "X" from Proposal to Negotiation',
      }),
    ]);
    const list = screen.getByRole("list", { name: "Activity" });
    expect(list.tagName).toBe("OL");
    const [first, second] = within(list).getAllByRole("listitem");
    expect(within(first).getByText("Updated")).toBeInTheDocument();
    expect(within(first).getByText('Olive updated customer "Acme 1"')).toBeInTheDocument();
    expect(within(first).getByText(/By Olive Owner/)).toBeInTheDocument();
    expect(within(second).getByText("Stage changed")).toBeInTheDocument();
    expect(container.querySelectorAll("svg[aria-hidden='true']").length).toBeGreaterThanOrEqual(2);
  });

  it("time: relative words in a <time> with the exact instant, the full local timestamp as title and for screen readers", () => {
    view([item(1)]);
    const time = screen.getByText("Yesterday").closest("time")!;
    expect(time).toHaveAttribute("datetime", "2026-11-09T09:00:00.000Z");
    expect(time).toHaveAttribute("title", "Nov 9, 2026, 9:00 AM");
    expect(screen.getByText("(Nov 9, 2026, 9:00 AM)")).toBeInTheDocument();
  });

  it("older than 30 days shows the date itself (once, not twice)", () => {
    view([item(1, { createdAt: "2026-08-08T09:00:00.000Z" })]);
    expect(screen.getAllByText("Aug 8, 2026, 9:00 AM")).toHaveLength(1);
  });

  it("links the summary to its record only when the record exists in the workspace; archived ones are marked and still linked", () => {
    view([
      item(1, { entity: { type: "customer", id: "c1", state: "active" } }),
      item(2, { entity: { type: "opportunity", id: "o2", state: "archived" } }),
      item(3, { entity: { type: "customer", id: "c3", state: "missing" } }),
      item(4, { entity: { type: "quote", id: "q4", state: "active" } }),
      item(5, { entity: { type: "task", id: "t5", state: "active" } }),
    ]);
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByRole("link")).toHaveAttribute("href", "/app/customers/c1");
    expect(within(items[0]).getByText(/Customer/)).toBeInTheDocument();
    expect(within(items[1]).getByRole("link")).toHaveAttribute("href", "/app/opportunities/o2");
    expect(within(items[1]).getByText("Archived")).toBeInTheDocument();
    expect(within(items[2]).queryByRole("link")).toBeNull(); // deleted: history stays, the link goes
    expect(within(items[3]).queryByRole("link")).toBeNull(); // quotes have no page yet
    expect(within(items[4]).getByRole("link")).toHaveAttribute("href", "/app/tasks");
  });

  it("changed fields: whitelisted values as plain words (money as dollars), free-text fields by NAME only", () => {
    view([
      item(1, {
        changes: [
          { field: "status", old: "lead", new: "active" },
          { field: "amount_cents", old: 100_000, new: 250_050 },
          { field: "probability_percent", old: 50, new: 75 },
          { field: "tags", old: ["a"], new: ["a", "b"] },
          { field: "assigned_to", old: null, new: "someone" },
          { field: "status", old: "in_progress", new: "done" },
        ],
        contentChanged: ["notes", "description"],
      }),
    ]);
    expect(screen.getByText("status: lead to active")).toBeInTheDocument();
    expect(screen.getByText("amount: $1,000.00 to $2,500.50")).toBeInTheDocument();
    expect(screen.getByText("probability: 50% to 75%")).toBeInTheDocument();
    expect(screen.getByText("tags: a to a, b")).toBeInTheDocument();
    expect(screen.getByText("owner: none to someone")).toBeInTheDocument();
    expect(screen.getAllByText("status: in progress to done")).toHaveLength(1);
    expect(screen.getByText("notes was edited")).toBeInTheDocument();
    expect(screen.getByText("description was edited")).toBeInTheDocument();
  });

  it("everything is text: markup in a summary or a value is shown, never run", () => {
    const { container } = view([
      item(1, {
        summary: 'Olive created customer "<img src=x onerror=alert(1)>"',
        changes: [{ field: "notes", old: "<b>x</b>", new: "<script>1</script>" }],
      }),
    ]);
    expect(container.querySelector("img, script, b")).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it("an action it does not know still shows, under its own name", () => {
    view([item(1, { action: "imported" })]);
    expect(screen.getByText("imported")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = view([
      item(1, {
        entity: { type: "customer", id: "c1", state: "archived" },
        changes: [{ field: "status", old: "lead", new: "active" }],
        contentChanged: ["notes"],
      }),
      item(2, { action: "archived" }),
    ]);
    await expectNoA11yViolations(container);
  });
});
