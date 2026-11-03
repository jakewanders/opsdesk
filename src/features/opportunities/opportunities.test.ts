import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaleEditError } from "@/lib/api/concurrency";
import { ForbiddenError, NotFoundError } from "@/lib/api/errors";
import {
  createOpportunitySchema,
  moveStageSchema,
  opportunityListQuery,
  toOpportunityDto,
  updateOpportunitySchema,
  type OpportunityRow,
} from "./schema";

const repo = vi.hoisted(() => ({
  findOpportunity: vi.fn(),
  updateOpportunity: vi.fn(),
  archiveOpportunity: vi.fn(),
  insertOpportunity: vi.fn(),
  listOpportunities: vi.fn(),
  moveStage: vi.fn(),
}));
const customers = vi.hoisted(() => ({ findCustomer: vi.fn() }));
vi.mock("./repository", async (orig) => ({
  ...(await orig<typeof import("./repository")>()),
  ...repo,
}));
vi.mock("@/features/customers/repository", async (orig) => ({
  ...(await orig<typeof import("@/features/customers/repository")>()),
  ...customers,
}));

const { archiveForOrg, createForOrg, getForOrg, listForOrg, moveStageForOrg, updateForOrg } =
  await import("./service");
const { changedColumns } = await import("./repository");

const ctx = (role: string, kind = "real") =>
  ({ role, kind, org: { id: "org-1" }, user: { id: "u" } }) as never;
const db = {} as never;
const UPDATED = "2026-11-02T01:02:03.123456+00:00";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const row = (over: Partial<OpportunityRow> = {}): OpportunityRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  customer_id: CUSTOMER,
  title: "Warehouse retrofit",
  description: null,
  stage: "qualified",
  amount_cents: 250000,
  probability_percent: 25,
  expected_close_date: "2026-12-01",
  assigned_to: null,
  lost_reason: null,
  closed_at: null,
  created_by: "u",
  created_at: "2026-11-01T00:00:00+00:00",
  updated_at: UPDATED,
  archived_at: null,
  customer: { display_name: "Acme", archived_at: null },
  ...over,
});
const ID = row().id;
const parse = (body: unknown) =>
  updateOpportunitySchema.parse({ expectedUpdatedAt: UPDATED, ...(body as object) });

beforeEach(() => {
  Object.values(repo).forEach((m) => m.mockReset());
  customers.findCustomer.mockReset();
});

describe("createOpportunitySchema", () => {
  const ok = { customerId: CUSTOMER, title: "Boiler" };
  it("applies the defaults: stage new, amount 0, no probability (the database applies the stage's)", () => {
    expect(createOpportunitySchema.parse(ok)).toEqual({
      customerId: CUSTOMER,
      title: "Boiler",
      description: null,
      stage: "new",
      amountCents: 0,
      expectedCloseDate: null,
      assignedTo: null,
    });
  });
  it("title 2 to 150, description at most 5,000", () => {
    for (const [title, valid] of [
      ["x", false],
      ["ab", true],
      ["a".repeat(150), true],
      ["a".repeat(151), false],
    ] as const)
      expect(createOpportunitySchema.safeParse({ ...ok, title }).success, title.length + "").toBe(
        valid,
      );
    expect(
      createOpportunitySchema.safeParse({ ...ok, description: "d".repeat(5001) }).success,
    ).toBe(false);
  });
  it("amount is whole non-negative cents, never a float or a string", () => {
    for (const [amountCents, valid] of [
      [0, true],
      [100000000000, true],
      [100000000001, false],
      [-1, false],
      [10.5, false],
      ["100", false],
    ] as const)
      expect(
        createOpportunitySchema.safeParse({ ...ok, amountCents }).success,
        String(amountCents),
      ).toBe(valid);
  });
  it("probability 0 to 100 whole, optional", () => {
    for (const [probabilityPercent, valid] of [
      [0, true],
      [100, true],
      [101, false],
      [-1, false],
      [50.5, false],
    ] as const)
      expect(
        createOpportunitySchema.safeParse({ ...ok, probabilityPercent }).success,
        String(probabilityPercent),
      ).toBe(valid);
    expect(createOpportunitySchema.parse({ ...ok, probabilityPercent: 0 }).probabilityPercent).toBe(
      0,
    );
  });
  it("only open stages at creation; won and lost go through the stage endpoint", () => {
    for (const stage of ["new", "qualified", "proposal", "negotiation"])
      expect(createOpportunitySchema.safeParse({ ...ok, stage }).success).toBe(true);
    for (const stage of ["won", "lost", "archived"])
      expect(createOpportunitySchema.safeParse({ ...ok, stage }).success).toBe(false);
  });
  it("customer is required and must be an id; date must exist; blank date and assignee are null", () => {
    expect(createOpportunitySchema.safeParse({ title: "Boiler" }).success).toBe(false);
    expect(createOpportunitySchema.safeParse({ ...ok, customerId: "nope" }).success).toBe(false);
    expect(
      createOpportunitySchema.safeParse({ ...ok, expectedCloseDate: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      createOpportunitySchema.parse({ ...ok, expectedCloseDate: "", assignedTo: " " }),
    ).toMatchObject({ expectedCloseDate: null, assignedTo: null });
  });
  it("refuses fields it does not own", () => {
    for (const extra of [
      { organizationId: CUSTOMER },
      { createdBy: CUSTOMER },
      { id: CUSTOMER },
      { lostReason: "x" },
      { closedAt: "2026-01-01" },
    ])
      expect(createOpportunitySchema.safeParse({ ...ok, ...extra }).success).toBe(false);
  });
});

describe("updateOpportunitySchema", () => {
  it("requires the last-seen updatedAt", () => {
    expect(updateOpportunitySchema.safeParse({ title: "New" }).success).toBe(false);
    expect(updateOpportunitySchema.safeParse({ expectedUpdatedAt: UPDATED }).success).toBe(true);
  });
  it("refuses `stage` with a message that names the stage endpoint", () => {
    const r = updateOpportunitySchema.safeParse({ expectedUpdatedAt: UPDATED, stage: "won" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("/stage");
    expect(
      updateOpportunitySchema.safeParse({ expectedUpdatedAt: UPDATED, stage: null }).success,
    ).toBe(false);
  });
  it("refuses lostReason, closedAt and ownership fields too", () => {
    for (const extra of [
      { lostReason: "x" },
      { closedAt: "2026-01-01" },
      { organizationId: CUSTOMER },
      { createdBy: CUSTOMER },
    ])
      expect(
        updateOpportunitySchema.safeParse({ expectedUpdatedAt: UPDATED, ...extra }).success,
      ).toBe(false);
  });
});

describe("opportunityListQuery", () => {
  it("defaults and whitelist", () => {
    const q = opportunityListQuery.parse({});
    expect(q).toMatchObject({
      page: 1,
      limit: 25,
      sort: "updated_at",
      order: "desc",
      archived: "false",
    });
    expect(opportunityListQuery.safeParse({ sort: "organization_id" }).success).toBe(false);
    expect(opportunityListQuery.safeParse({ stage: "bogus" }).success).toBe(false);
    expect(opportunityListQuery.safeParse({ closeFrom: "2026-13-01" }).success).toBe(false);
    expect(opportunityListQuery.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("toOpportunityDto", () => {
  it("camelCases, carries the customer's name and keeps money as integer cents", () => {
    expect(toOpportunityDto(row())).toMatchObject({
      customerName: "Acme",
      customerArchived: false,
      amountCents: 250000,
      probabilityPercent: 25,
      stage: "qualified",
    });
    expect(toOpportunityDto(row({ customer: undefined })).customerName).toBeNull();
  });
});

describe("changedColumns", () => {
  it("lists only what really differs", () => {
    expect(
      changedColumns(row(), {
        title: "Warehouse retrofit",
        amountCents: 300000,
        expectedCloseDate: "2026-12-01",
      }),
    ).toEqual({ amount_cents: 300000 });
    expect(changedColumns(row(), { assignedTo: null, description: null })).toEqual({});
    expect(changedColumns(row({ assigned_to: "u1" }), { assignedTo: null })).toEqual({
      assigned_to: null,
    });
    expect(changedColumns(row(), {})).toEqual({});
  });
});

describe("service: permissions (before any database call)", () => {
  it("a viewer can read but not write", async () => {
    repo.findOpportunity.mockResolvedValue(row());
    repo.listOpportunities.mockResolvedValue({ items: [], meta: {} });
    await expect(getForOrg(db, ctx("viewer"), ID)).resolves.toBeTruthy();
    await expect(
      listForOrg(db, ctx("viewer"), opportunityListQuery.parse({})),
    ).resolves.toBeTruthy();
    repo.findOpportunity.mockClear();
    for (const call of [
      () =>
        createForOrg(
          db,
          ctx("viewer"),
          createOpportunitySchema.parse({ customerId: CUSTOMER, title: "Deal" }),
        ),
      () => updateForOrg(db, ctx("viewer"), ID, parse({ title: "New title" })),
      () => archiveForOrg(db, ctx("viewer"), ID),
    ])
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    expect(repo.findOpportunity).not.toHaveBeenCalled();
    expect(repo.insertOpportunity).not.toHaveBeenCalled();
  });
});

describe("service: createForOrg", () => {
  const input = () => createOpportunitySchema.parse({ customerId: CUSTOMER, title: "Deal" });
  it("404 CUSTOMER_NOT_FOUND for a customer outside the workspace, and nothing is written", async () => {
    customers.findCustomer.mockResolvedValue(null);
    const err = await createForOrg(db, ctx("member"), input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    expect(repo.insertOpportunity).not.toHaveBeenCalled();
  });
  it("inserts when the customer is visible", async () => {
    customers.findCustomer.mockResolvedValue({ id: CUSTOMER });
    repo.insertOpportunity.mockResolvedValue({ id: ID });
    await expect(createForOrg(db, ctx("member"), input())).resolves.toEqual({ id: ID });
    expect(repo.insertOpportunity).toHaveBeenCalledWith(
      db,
      "org-1",
      expect.objectContaining({ customerId: CUSTOMER }),
    );
  });
});

describe("service: updateForOrg", () => {
  it("404 for a missing or foreign opportunity", async () => {
    repo.findOpportunity.mockResolvedValue(null);
    await expect(
      updateForOrg(db, ctx("member"), ID, parse({ title: "New title" })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.updateOpportunity).not.toHaveBeenCalled();
  });
  it("409 STALE_EDIT with the current version, and nothing is written (even for a no-op patch)", async () => {
    repo.findOpportunity.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00.000001+00:00" }));
    for (const body of [{ title: "New title" }, {}]) {
      const err = await updateForOrg(db, ctx("member"), ID, parse(body)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StaleEditError);
      expect(err).toMatchObject({
        status: 409,
        code: "STALE_EDIT",
        current: { updatedAt: "2026-11-02T09:00:00.000001+00:00" },
      });
    }
    expect(repo.updateOpportunity).not.toHaveBeenCalled();
  });
  it("a patch that changes nothing writes nothing and returns the current deal", async () => {
    repo.findOpportunity.mockResolvedValue(row());
    const out = await updateForOrg(db, ctx("member"), ID, parse({ title: "Warehouse retrofit" }));
    expect(out.id).toBe(ID);
    expect(repo.updateOpportunity).not.toHaveBeenCalled();
  });
  it("sends only the changed columns with the version the client saw", async () => {
    repo.findOpportunity.mockResolvedValue(row());
    repo.updateOpportunity.mockResolvedValue({ id: ID });
    await updateForOrg(
      db,
      ctx("member"),
      ID,
      parse({ title: "Retrofit phase 2", amountCents: 250000 }),
    );
    expect(repo.updateOpportunity).toHaveBeenCalledWith(db, ID, UPDATED, {
      title: "Retrofit phase 2",
    });
  });
  it("a new customer must be visible in the workspace (404, nothing written)", async () => {
    repo.findOpportunity.mockResolvedValue(row());
    customers.findCustomer.mockResolvedValue(null);
    await expect(
      updateForOrg(
        db,
        ctx("member"),
        ID,
        parse({ customerId: "33333333-3333-4333-8333-333333333333" }),
      ),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    expect(repo.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe("service: archiveForOrg", () => {
  it("404 when missing, otherwise archives", async () => {
    repo.findOpportunity.mockResolvedValue(null);
    await expect(archiveForOrg(db, ctx("member"), ID)).rejects.toBeInstanceOf(NotFoundError);
    repo.findOpportunity.mockResolvedValue(row());
    await archiveForOrg(db, ctx("member"), ID);
    expect(repo.archiveOpportunity).toHaveBeenCalledWith(db, "org-1", ID);
  });
});

describe("moveStageSchema", () => {
  it("needs a known stage and the last-seen version; the reason is optional text", () => {
    const base = { expectedUpdatedAt: UPDATED, stage: "lost" };
    expect(moveStageSchema.safeParse(base).success).toBe(true);
    expect(moveStageSchema.parse(base).lostReason).toBeNull();
    expect(moveStageSchema.parse({ ...base, lostReason: "  Price  " }).lostReason).toBe("Price");
    expect(moveStageSchema.parse({ ...base, lostReason: "   " }).lostReason).toBeNull();
    expect(moveStageSchema.safeParse({ ...base, lostReason: "r".repeat(501) }).success).toBe(false);
    expect(moveStageSchema.safeParse({ ...base, lostReason: "r".repeat(500) }).success).toBe(true);
    for (const bad of [
      { stage: "archived" },
      { stage: undefined },
      { expectedUpdatedAt: undefined },
      { organizationId: CUSTOMER },
      { closedAt: "2026-01-01" },
    ])
      expect(moveStageSchema.safeParse({ ...base, ...bad }).success).toBe(false);
  });
});

describe("service: moveStageForOrg", () => {
  const input = (over: object = {}) =>
    moveStageSchema.parse({ expectedUpdatedAt: UPDATED, stage: "won", ...over });
  it("a viewer is refused before any database call", async () => {
    await expect(moveStageForOrg(db, ctx("viewer"), ID, input())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(repo.findOpportunity).not.toHaveBeenCalled();
    expect(repo.moveStage).not.toHaveBeenCalled();
  });
  it("404 for a missing or foreign deal; 409 with the current version for a stale one; neither calls the function", async () => {
    repo.findOpportunity.mockResolvedValue(null);
    await expect(moveStageForOrg(db, ctx("member"), ID, input())).rejects.toBeInstanceOf(
      NotFoundError,
    );
    repo.findOpportunity.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00.000001+00:00" }));
    await expect(moveStageForOrg(db, ctx("member"), ID, input())).rejects.toMatchObject({
      status: 409,
      code: "STALE_EDIT",
      current: { updatedAt: "2026-11-02T09:00:00.000001+00:00" },
    });
    expect(repo.moveStage).not.toHaveBeenCalled();
  });
  it("passes the stage, the reason and the version it saw to the function and returns its result", async () => {
    repo.findOpportunity.mockResolvedValue(row());
    repo.moveStage.mockResolvedValue({ id: ID, stage: "lost" });
    await expect(
      moveStageForOrg(db, ctx("admin"), ID, input({ stage: "lost", lostReason: "Price" })),
    ).resolves.toEqual({ id: ID, stage: "lost" });
    expect(repo.moveStage).toHaveBeenCalledWith(db, "org-1", ID, "lost", "Price", UPDATED);
  });
  it("a conflict found inside the function (a writer got in after the read) is a 409 with the version that is there now", async () => {
    repo.findOpportunity
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ updated_at: "2026-11-02T09:30:00+00:00" }));
    repo.moveStage.mockResolvedValue("stale");
    await expect(moveStageForOrg(db, ctx("member"), ID, input())).rejects.toMatchObject({
      status: 409,
      code: "STALE_EDIT",
      current: { updatedAt: "2026-11-02T09:30:00+00:00" },
    });
  });
});
