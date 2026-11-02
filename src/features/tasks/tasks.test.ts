import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaleEditError } from "@/lib/api/concurrency";
import { ForbiddenError, NotFoundError } from "@/lib/api/errors";
import {
  completeTaskSchema,
  createTaskSchema,
  taskListQuery,
  toTaskDto,
  updateTaskSchema,
  type TaskRow,
} from "./schema";

const repo = vi.hoisted(() => ({
  findTask: vi.fn(),
  updateTask: vi.fn(),
  archiveTask: vi.fn(),
  insertTask: vi.fn(),
  listTasks: vi.fn(),
}));
const customers = vi.hoisted(() => ({ findCustomer: vi.fn() }));
const deals = vi.hoisted(() => ({ findOpportunity: vi.fn() }));
vi.mock("./repository", async (orig) => ({
  ...(await orig<typeof import("./repository")>()),
  ...repo,
}));
vi.mock("@/features/customers/repository", async (orig) => ({
  ...(await orig<typeof import("@/features/customers/repository")>()),
  ...customers,
}));
vi.mock("@/features/opportunities/repository", async (orig) => ({
  ...(await orig<typeof import("@/features/opportunities/repository")>()),
  ...deals,
}));

const { archiveForOrg, completeForOrg, createForOrg, getForOrg, listForOrg, updateForOrg } =
  await import("./service");
const { changedColumns } = await import("./repository");

const ctx = (role: string) =>
  ({
    role,
    kind: "real",
    org: { id: "org-1", timezone: "America/New_York" },
    user: { id: "user-1" },
  }) as never;
const db = {} as never;
const UPDATED = "2026-11-02T01:02:03.123456+00:00";
const LINK = "22222222-2222-4222-8222-222222222222";
const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "Call the client",
  description: null,
  status: "todo",
  priority: "medium",
  due_date: "2026-12-01",
  assigned_to: null,
  customer_id: null,
  opportunity_id: null,
  completed_at: null,
  created_by: "user-1",
  created_at: "2026-11-01T00:00:00+00:00",
  updated_at: UPDATED,
  archived_at: null,
  ...over,
});
const ID = row().id;
const patch = (body: unknown) =>
  updateTaskSchema.parse({ expectedUpdatedAt: UPDATED, ...(body as object) });
const complete = (body: unknown) =>
  completeTaskSchema.parse({ expectedUpdatedAt: UPDATED, ...(body as object) });

beforeEach(() => {
  Object.values(repo).forEach((m) => m.mockReset());
  customers.findCustomer.mockReset();
  deals.findOpportunity.mockReset();
});

describe("createTaskSchema", () => {
  it("defaults: status todo, priority medium, everything else null", () => {
    expect(createTaskSchema.parse({ title: "Call back" })).toEqual({
      title: "Call back",
      description: null,
      status: "todo",
      priority: "medium",
      dueDate: null,
      assignedTo: null,
      customerId: null,
      opportunityId: null,
    });
  });
  it("title 2 to 160, description at most 5,000, real dates, known enums", () => {
    for (const [title, ok] of [
      ["x", false],
      ["ab", true],
      ["a".repeat(160), true],
      ["a".repeat(161), false],
    ] as const)
      expect(createTaskSchema.safeParse({ title }).success, `${title.length}`).toBe(ok);
    expect(
      createTaskSchema.safeParse({ title: "Ok task", description: "d".repeat(5001) }).success,
    ).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Ok task", dueDate: "2026-02-30" }).success).toBe(
      false,
    );
    expect(createTaskSchema.safeParse({ title: "Ok task", dueDate: "tomorrow" }).success).toBe(
      false,
    );
    expect(createTaskSchema.parse({ title: "Ok task", dueDate: "" }).dueDate).toBeNull();
    for (const bad of [
      { status: "open" },
      { priority: "critical" },
      { assignedTo: "nope" },
      { customerId: "nope" },
    ])
      expect(createTaskSchema.safeParse({ title: "Ok task", ...bad }).success).toBe(false);
  });
  it("a blocked task needs no reason (it lives in the description)", () => {
    expect(createTaskSchema.safeParse({ title: "Stuck task", status: "blocked" }).success).toBe(
      true,
    );
  });
  it("refuses fields the database owns or the caller must not set", () => {
    for (const extra of [
      { completedAt: "2026-01-01T00:00:00Z" },
      { organizationId: LINK },
      { createdBy: LINK },
      { id: LINK },
      { archivedAt: "2026-01-01" },
    ])
      expect(createTaskSchema.safeParse({ title: "Ok task", ...extra }).success).toBe(false);
  });
});

describe("updateTaskSchema and completeTaskSchema", () => {
  it("the update needs the last-seen version; the complete body needs a real boolean", () => {
    expect(updateTaskSchema.safeParse({ title: "New" }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ expectedUpdatedAt: UPDATED }).success).toBe(true);
    expect(completeTaskSchema.safeParse({ expectedUpdatedAt: UPDATED }).success).toBe(false);
    expect(
      completeTaskSchema.safeParse({ expectedUpdatedAt: UPDATED, completed: "true" }).success,
    ).toBe(false);
    expect(
      completeTaskSchema.safeParse({ expectedUpdatedAt: UPDATED, completed: false, status: "done" })
        .success,
    ).toBe(false);
    expect(
      completeTaskSchema.safeParse({
        expectedUpdatedAt: UPDATED,
        completed: false,
        status: "in_progress",
      }).success,
    ).toBe(true);
    expect(
      completeTaskSchema.safeParse({
        expectedUpdatedAt: UPDATED,
        completed: true,
        completedAt: "x",
      }).success,
    ).toBe(false);
  });
});

describe("taskListQuery", () => {
  it("defaults, whitelist and flags", () => {
    expect(taskListQuery.parse({})).toMatchObject({
      page: 1,
      limit: 25,
      sort: "due_date",
      order: "asc",
      archived: "false",
    });
    expect(taskListQuery.parse({ overdue: "true", assignedToMe: "false" })).toMatchObject({
      overdue: "true",
      assignedToMe: "false",
    });
    for (const bad of [
      { sort: "organization_id" },
      { overdue: "yes" },
      { status: "open" },
      { priority: "x" },
      { limit: "101" },
      { nope: "1" },
    ])
      expect(taskListQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(taskListQuery.safeParse({ sort: "priority" }).success).toBe(true);
  });
});

describe("toTaskDto", () => {
  it("camelCases, carries link names and computes dueState in the organization's zone", () => {
    const now = new Date("2026-11-02T03:00:00Z"); // still Nov 1 in New York
    expect(
      toTaskDto(
        row({ due_date: "2026-11-01", customer: { display_name: "Acme" } }),
        "America/New_York",
        now,
      ),
    ).toMatchObject({ customerName: "Acme", dueState: "due_soon" });
    expect(toTaskDto(row({ due_date: "2026-11-01" }), "UTC", now).dueState).toBe("overdue");
    // 03:00 UTC on Nov 2 is still Nov 1 in New York: due on Nov 1 there is "today", in UTC it is yesterday
    expect(toTaskDto(row({ due_date: "2026-11-01" }), "America/New_York", now).dueToday).toBe(true);
    expect(toTaskDto(row({ due_date: "2026-11-01" }), "UTC", now).dueToday).toBe(false);
    expect(toTaskDto(row({ due_date: "2026-11-02" }), "UTC", now).dueToday).toBe(true);
    expect(toTaskDto(row({ due_date: "2026-11-02", status: "done" }), "UTC", now).dueToday).toBe(
      false,
    );
    expect(toTaskDto(row({ due_date: null }), "UTC", now).dueToday).toBe(false);
    expect(toTaskDto(row({ status: "done", due_date: "2020-01-01" }), "UTC", now).dueState).toBe(
      "done",
    );
    expect(toTaskDto(row({ due_date: null }), "UTC", now).dueState).toBe("none");
  });
});

describe("changedColumns", () => {
  it("lists only what really differs", () => {
    expect(
      changedColumns(row(), { title: "Call the client", priority: "high", dueDate: "2026-12-01" }),
    ).toEqual({ priority: "high" });
    expect(changedColumns(row({ assigned_to: "u1" }), { assignedTo: null })).toEqual({
      assigned_to: null,
    });
    expect(changedColumns(row(), { description: null, customerId: null })).toEqual({});
  });
});

describe("permissions (before any database call)", () => {
  it("a viewer can read but not write", async () => {
    repo.findTask.mockResolvedValue(row());
    repo.listTasks.mockResolvedValue({ items: [], meta: {} });
    await expect(getForOrg(db, ctx("viewer"), ID)).resolves.toBeTruthy();
    await expect(listForOrg(db, ctx("viewer"), taskListQuery.parse({}))).resolves.toBeTruthy();
    repo.findTask.mockClear();
    for (const call of [
      () => createForOrg(db, ctx("viewer"), createTaskSchema.parse({ title: "Nope task" })),
      () => updateForOrg(db, ctx("viewer"), ID, patch({ title: "New title" })),
      () => completeForOrg(db, ctx("viewer"), ID, complete({ completed: true })),
      () => archiveForOrg(db, ctx("viewer"), ID),
    ])
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.findTask).not.toHaveBeenCalled();
    expect(repo.insertTask).not.toHaveBeenCalled();
  });
});

describe("listForOrg", () => {
  it("passes the caller, the organization and TODAY IN THE ORGANIZATION'S ZONE to the repository", async () => {
    repo.listTasks.mockResolvedValue({ items: [], meta: {} });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00Z")); // Nov 2 in UTC, still Nov 1 in New York
    try {
      await listForOrg(db, ctx("member"), taskListQuery.parse({ overdue: "true" }));
    } finally {
      vi.useRealTimers();
    }
    expect(repo.listTasks).toHaveBeenCalledWith(
      db,
      { orgId: "org-1", userId: "user-1", today: "2026-11-01" },
      "America/New_York",
      expect.anything(),
    );
  });
});

describe("createForOrg", () => {
  const input = (over: object = {}) => createTaskSchema.parse({ title: "New task", ...over });
  it("404 for a customer or deal outside the workspace, and nothing is written", async () => {
    customers.findCustomer.mockResolvedValue(null);
    await expect(
      createForOrg(db, ctx("member"), input({ customerId: LINK })),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    customers.findCustomer.mockResolvedValue({ id: LINK });
    deals.findOpportunity.mockResolvedValue(null);
    await expect(
      createForOrg(db, ctx("member"), input({ customerId: LINK, opportunityId: LINK })),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    expect(repo.insertTask).not.toHaveBeenCalled();
  });
  it("inserts with no links without looking anything up", async () => {
    repo.insertTask.mockResolvedValue({ id: ID });
    await expect(createForOrg(db, ctx("member"), input())).resolves.toEqual({ id: ID });
    expect(customers.findCustomer).not.toHaveBeenCalled();
  });
});

describe("updateForOrg", () => {
  it("404 for a missing task; 409 with the current version when stale (even for a no-op)", async () => {
    repo.findTask.mockResolvedValue(null);
    await expect(
      updateForOrg(db, ctx("member"), ID, patch({ title: "New title" })),
    ).rejects.toBeInstanceOf(NotFoundError);
    repo.findTask.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00.000001+00:00" }));
    for (const body of [{ title: "New title" }, {}])
      await expect(updateForOrg(db, ctx("member"), ID, patch(body))).rejects.toBeInstanceOf(
        StaleEditError,
      );
    expect(repo.updateTask).not.toHaveBeenCalled();
  });
  it("a no-op writes nothing; a change sends only the changed columns", async () => {
    repo.findTask.mockResolvedValue(row());
    await updateForOrg(db, ctx("member"), ID, patch({ title: "Call the client" }));
    expect(repo.updateTask).not.toHaveBeenCalled();
    repo.updateTask.mockResolvedValue({ id: ID });
    await updateForOrg(
      db,
      ctx("member"),
      ID,
      patch({ title: "Call the client", priority: "urgent" }),
    );
    expect(repo.updateTask).toHaveBeenCalledWith(db, "America/New_York", ID, UPDATED, {
      priority: "urgent",
    });
  });
  it("a new link must be visible in the workspace", async () => {
    repo.findTask.mockResolvedValue(row());
    customers.findCustomer.mockResolvedValue(null);
    await expect(
      updateForOrg(db, ctx("member"), ID, patch({ customerId: LINK })),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    expect(repo.updateTask).not.toHaveBeenCalled();
  });
});

describe("completeForOrg", () => {
  it("completing an open task sets status done; reopening a done task goes to todo or the chosen status", async () => {
    repo.updateTask.mockResolvedValue({ id: ID });
    repo.findTask.mockResolvedValue(row({ status: "in_progress" }));
    await completeForOrg(db, ctx("member"), ID, complete({ completed: true }));
    expect(repo.updateTask).toHaveBeenLastCalledWith(db, "America/New_York", ID, UPDATED, {
      status: "done",
    });
    repo.findTask.mockResolvedValue(
      row({ status: "done", completed_at: "2026-11-01T00:00:00+00:00" }),
    );
    await completeForOrg(db, ctx("member"), ID, complete({ completed: false }));
    expect(repo.updateTask).toHaveBeenLastCalledWith(db, "America/New_York", ID, UPDATED, {
      status: "todo",
    });
    await completeForOrg(db, ctx("member"), ID, complete({ completed: false, status: "blocked" }));
    expect(repo.updateTask).toHaveBeenLastCalledWith(db, "America/New_York", ID, UPDATED, {
      status: "blocked",
    });
  });
  it("asking for the state the task is already in writes nothing", async () => {
    repo.findTask.mockResolvedValue(row({ status: "done" }));
    await expect(
      completeForOrg(db, ctx("member"), ID, complete({ completed: true })),
    ).resolves.toMatchObject({ status: "done" });
    repo.findTask.mockResolvedValue(row({ status: "blocked" }));
    await expect(
      completeForOrg(db, ctx("member"), ID, complete({ completed: false })),
    ).resolves.toMatchObject({ status: "blocked" });
    expect(repo.updateTask).not.toHaveBeenCalled();
  });
  it("404 when missing, 409 when stale", async () => {
    repo.findTask.mockResolvedValue(null);
    await expect(
      completeForOrg(db, ctx("member"), ID, complete({ completed: true })),
    ).rejects.toBeInstanceOf(NotFoundError);
    repo.findTask.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00+00:00" }));
    await expect(
      completeForOrg(db, ctx("member"), ID, complete({ completed: true })),
    ).rejects.toBeInstanceOf(StaleEditError);
  });
});

describe("archiveForOrg", () => {
  it("404 when missing, otherwise archives", async () => {
    repo.findTask.mockResolvedValue(null);
    await expect(archiveForOrg(db, ctx("member"), ID)).rejects.toBeInstanceOf(NotFoundError);
    repo.findTask.mockResolvedValue(row());
    await archiveForOrg(db, ctx("member"), ID);
    expect(repo.archiveTask).toHaveBeenCalledWith(db, "org-1", ID);
  });
});
