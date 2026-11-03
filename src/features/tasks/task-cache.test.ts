import { describe, expect, it } from "vitest";
import type { ApiResponse } from "@/lib/api-client/api-fetch";
import { applyTaskChange, toggledTask } from "./task-cache";
import type { TaskDto } from "./schema";

const NOW = new Date("2026-11-02T03:00:00Z"); // 03:00 UTC: still Nov 1 in New York, Nov 2 in UTC
const task = (id: string, over: Partial<TaskDto> = {}): TaskDto => ({
  id,
  title: id,
  description: null,
  status: "todo",
  priority: "medium",
  dueDate: "2026-10-30",
  dueState: "overdue",
  dueToday: false,
  assignedTo: null,
  customerId: null,
  customerName: null,
  customerArchived: false,
  opportunityId: null,
  opportunityTitle: null,
  opportunityArchived: false,
  completedAt: null,
  createdBy: null,
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  archivedAt: null,
  ...over,
});
const list = (tasks: TaskDto[], total = tasks.length, limit = 25): ApiResponse<TaskDto[]> => ({
  data: tasks,
  meta: { page: 1, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
});

describe("toggledTask", () => {
  it("completing: done, a completion time, and no overdue or due-today mark", () => {
    const t = task("a", { dueToday: true, dueState: "due_soon" });
    const done = toggledTask(t, true, { now: NOW, timeZone: "UTC" });
    expect(done).toMatchObject({
      status: "done",
      completedAt: NOW.toISOString(),
      dueState: "done",
      dueToday: false,
    });
    expect(t.status).toBe("todo"); // the input is untouched
  });
  it("reopening: back to todo (or the chosen status), no completion time, and the due marks from the SHARED rules in the organization's zone", () => {
    const doneLate = task("a", {
      status: "done",
      dueState: "done",
      completedAt: NOW.toISOString(),
      dueDate: "2026-11-01",
    });
    // due Nov 1: in New York it is still Nov 1 (due today), in UTC it is Nov 2 (overdue)
    expect(toggledTask(doneLate, false, { now: NOW, timeZone: "America/New_York" })).toMatchObject({
      status: "todo",
      completedAt: null,
      dueToday: true,
      dueState: "due_soon",
    });
    expect(toggledTask(doneLate, false, { now: NOW, timeZone: "UTC" })).toMatchObject({
      dueToday: false,
      dueState: "overdue",
    });
    expect(
      toggledTask(doneLate, false, { now: NOW, timeZone: "UTC", reopenStatus: "blocked" }).status,
    ).toBe("blocked");
    expect(
      toggledTask(doneLate, false, { now: NOW, timeZone: "UTC", reopenStatus: "done" }).status,
    ).toBe("todo");
    expect(
      toggledTask({ ...doneLate, dueDate: null }, false, { now: NOW, timeZone: "UTC" }).dueState,
    ).toBe("none");
  });
});

describe("applyTaskChange", () => {
  const a = task("a");
  const b = task("b", { dueState: "later", dueDate: "2026-12-01" });
  const doneA = toggledTask(a, true, { now: NOW, timeZone: "UTC" });

  it("updates the row in place when the list still shows it", () => {
    const out = applyTaskChange(list([a, b]), {}, doneA);
    expect(out.data.map((t) => `${t.id}:${t.status}`)).toEqual(["a:done", "b:todo"]);
    expect(out.meta.total).toBe(2);
  });
  it("removes it from the Overdue view and lowers the total and page count", () => {
    const out = applyTaskChange(list([a, b], 26, 25), { overdue: "true" }, doneA);
    expect(out.data.map((t) => t.id)).toEqual(["b"]);
    expect(out.meta).toMatchObject({ total: 25, totalPages: 1 });
  });
  it("removes it from a status view it no longer matches, and keeps it in a view it matches", () => {
    expect(applyTaskChange(list([a, b]), { status: "todo" }, doneA).data.map((t) => t.id)).toEqual([
      "b",
    ]);
    expect(
      applyTaskChange(list([doneA, b]), { status: "done" }, doneA).data.map((t) => t.id),
    ).toEqual(["a", "b"]);
  });
  it("leaves lists that do not contain the task untouched (same object) and never goes below zero", () => {
    const c = list([b]);
    expect(applyTaskChange(c, { overdue: "true" }, doneA)).toBe(c);
    expect(applyTaskChange(list([a], 0), { overdue: "true" }, doneA).meta.total).toBe(0);
  });
  it("does not mutate the cached list", () => {
    const cached = list([a, b]);
    const copy = JSON.stringify(cached);
    applyTaskChange(cached, { overdue: "true" }, doneA);
    expect(JSON.stringify(cached)).toBe(copy);
  });
});
