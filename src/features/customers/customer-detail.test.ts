import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaleEditError } from "@/lib/api/concurrency";
import { ForbiddenError, NotFoundError } from "@/lib/api/errors";
import type { CustomerRow } from "./schema";
import { updateCustomerSchema } from "./schema";

const repo = vi.hoisted(() => ({
  findCustomer: vi.fn(),
  updateCustomer: vi.fn(),
  setArchived: vi.fn(),
  countRelated: vi.fn(),
  findOtherCustomerWithEmail: vi.fn(),
  insertCustomer: vi.fn(),
  listCustomers: vi.fn(),
}));
vi.mock("./repository", async (orig) => ({
  ...(await orig<typeof import("./repository")>()),
  ...repo,
}));

const { archiveForOrg, getForOrg, restoreForOrg, updateForOrg } = await import("./service");
const { changedColumns } = await import("./repository");

const ctx = (role: string, kind = "real") =>
  ({ role, kind, org: { id: "org-1" }, user: { id: "u" } }) as never;
const db = {} as never;
const UPDATED = "2026-11-02T01:02:03.123456+00:00";
const row = (over: Partial<CustomerRow> = {}): CustomerRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  type: "person",
  display_name: "Acme",
  company_name: null,
  email: "a@b.co",
  phone: null,
  website: null,
  status: "lead",
  source: "other",
  tags: ["x"],
  notes: null,
  assigned_to: null,
  created_by: "u",
  created_at: "2026-11-01T00:00:00+00:00",
  updated_at: UPDATED,
  archived_at: null,
  ...over,
});
const ID = row().id;
const parse = (body: unknown) =>
  updateCustomerSchema.parse({ expectedUpdatedAt: UPDATED, ...(body as object) });

beforeEach(() => Object.values(repo).forEach((m) => m.mockReset()));

describe("updateCustomerSchema", () => {
  it("requires the last-seen updatedAt, in the format the API returned", () => {
    expect(updateCustomerSchema.safeParse({ displayName: "New" }).success).toBe(false);
    expect(
      updateCustomerSchema.safeParse({ expectedUpdatedAt: "yesterday", displayName: "New" })
        .success,
    ).toBe(false);
    expect(updateCustomerSchema.safeParse({ expectedUpdatedAt: UPDATED }).success).toBe(true);
  });
  it("absent means unchanged, null or blank means cleared", () => {
    const r = parse({ companyName: "", notes: null, phone: "  " });
    expect(r).toMatchObject({ companyName: null, notes: null, phone: null });
    const keys = Object.keys(parse({ displayName: "Only name" }));
    expect(keys.sort()).toEqual(["displayName", "expectedUpdatedAt"]);
  });
  it("validates every field like create", () => {
    for (const bad of [
      { displayName: "x" },
      { email: "nope" },
      { website: "javascript:alert(1)" },
      { status: "won" },
      { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { notes: "n".repeat(5001) },
      { assignedTo: "me" },
      { displayName: "<b>x</b>" },
    ]) {
      expect(
        updateCustomerSchema.safeParse({ expectedUpdatedAt: UPDATED, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });
  it("refuses every field that must not change", () => {
    for (const extra of [
      "organizationId",
      "organization_id",
      "createdBy",
      "created_by",
      "id",
      "createdAt",
      "updatedAt",
      "archivedAt",
      "searchText",
    ]) {
      expect(
        updateCustomerSchema.safeParse({ expectedUpdatedAt: UPDATED, [extra]: "x" }).success,
        extra,
      ).toBe(false);
    }
  });
});

describe("changedColumns", () => {
  it("lists only what really differs, mapped to columns", () => {
    expect(
      changedColumns(row(), {
        displayName: "Acme",
        status: "active",
        tags: ["x"],
        email: "a@b.co",
      }),
    ).toEqual({ status: "active" });
    expect(changedColumns(row(), { companyName: "Acme Co", tags: ["x", "y"] })).toEqual({
      company_name: "Acme Co",
      tags: ["x", "y"],
    });
  });
  it("treats null and absent consistently, and compares tag lists by value", () => {
    expect(changedColumns(row({ phone: null }), { phone: null })).toEqual({});
    expect(changedColumns(row({ tags: ["a", "b"] }), { tags: ["a", "b"] })).toEqual({});
    expect(changedColumns(row({ tags: ["a", "b"] }), { tags: ["b", "a"] })).toEqual({
      tags: ["b", "a"],
    });
    expect(changedColumns(row({ assigned_to: "u1" }), { assignedTo: null })).toEqual({
      assigned_to: null,
    });
    expect(changedColumns(row(), {})).toEqual({});
  });
});

describe("service: permissions (before any database call)", () => {
  it("a viewer can read but not write", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.countRelated.mockResolvedValue({ opportunities: 0, tasks: 0, quotes: 0 });
    await expect(getForOrg(db, ctx("viewer"), ID)).resolves.toBeTruthy();
    repo.findCustomer.mockClear();
    for (const call of [
      () => updateForOrg(db, ctx("viewer"), ID, parse({ displayName: "x y" })),
      () => archiveForOrg(db, ctx("viewer"), ID),
      () => restoreForOrg(db, ctx("viewer"), ID),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(repo.findCustomer).not.toHaveBeenCalled();
  });
});

describe("service: updateForOrg", () => {
  it("404 for a missing or foreign customer, before anything else", async () => {
    repo.findCustomer.mockResolvedValue(null);
    await expect(
      updateForOrg(db, ctx("member"), ID, parse({ displayName: "New Name" })),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(repo.updateCustomer).not.toHaveBeenCalled();
  });
  it("409 STALE_EDIT with the current version when the client's copy is old, and nothing is written", async () => {
    repo.findCustomer.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00.000001+00:00" }));
    const err = await updateForOrg(db, ctx("member"), ID, parse({ displayName: "New Name" })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StaleEditError);
    expect(err).toMatchObject({
      status: 409,
      code: "STALE_EDIT",
      current: { updatedAt: "2026-11-02T09:00:00.000001+00:00" },
    });
    expect(repo.updateCustomer).not.toHaveBeenCalled();
  });
  it("a stale no-op patch is still 409 (the client's view is old)", async () => {
    repo.findCustomer.mockResolvedValue(row({ updated_at: "2026-11-02T09:00:00+00:00" }));
    await expect(updateForOrg(db, ctx("member"), ID, parse({}))).rejects.toBeInstanceOf(
      StaleEditError,
    );
  });
  it("a no-op patch is a success that writes nothing", async () => {
    repo.findCustomer.mockResolvedValue(row());
    const r = await updateForOrg(
      db,
      ctx("member"),
      ID,
      parse({ displayName: "Acme", status: "lead", tags: ["x"] }),
    );
    expect(r.customer.displayName).toBe("Acme");
    expect(r.warnings).toEqual([]);
    expect(repo.updateCustomer).not.toHaveBeenCalled();
  });
  it("sends only the changed columns, with the version the client saw", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.updateCustomer.mockResolvedValue({ ...row(), displayName: "x" });
    await updateForOrg(db, ctx("member"), ID, parse({ displayName: "Acme", status: "active" }));
    expect(repo.updateCustomer).toHaveBeenCalledWith(db, ID, UPDATED, { status: "active" });
  });
  it("warns, without failing, when the new e-mail is already used", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.updateCustomer.mockResolvedValue({ id: ID, email: "dup@x.co" });
    repo.findOtherCustomerWithEmail.mockResolvedValue({ id: "other", displayName: "Twin" });
    const r = await updateForOrg(db, ctx("admin"), ID, parse({ email: "DUP@x.co" }));
    expect(r.warnings).toEqual([
      expect.objectContaining({ code: "DUPLICATE_EMAIL", customerId: "other" }),
    ]);
  });
  it("does not look for duplicates when the e-mail did not change", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.updateCustomer.mockResolvedValue({ id: ID, email: "a@b.co" });
    await updateForOrg(db, ctx("member"), ID, parse({ status: "active" }));
    expect(repo.findOtherCustomerWithEmail).not.toHaveBeenCalled();
  });
});

describe("service: archive and restore", () => {
  it("404 for a missing customer; archive is idempotent (an already archived one is still a success)", async () => {
    repo.findCustomer.mockResolvedValue(null);
    await expect(archiveForOrg(db, ctx("member"), ID)).rejects.toBeInstanceOf(NotFoundError);
    repo.findCustomer.mockResolvedValue(row({ archived_at: "2026-11-01T00:00:00+00:00" }));
    repo.setArchived.mockResolvedValue(null);
    await expect(archiveForOrg(db, ctx("member"), ID)).resolves.toBeUndefined();
    expect(repo.setArchived).toHaveBeenCalledWith(db, "org-1", ID, true);
  });
  it("restore returns the customer, and an already active one comes back unchanged", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.setArchived.mockResolvedValue(null);
    expect((await restoreForOrg(db, ctx("member"), ID)).archivedAt).toBeNull();
    repo.setArchived.mockResolvedValue({ ...row() });
    await restoreForOrg(db, ctx("member"), ID);
    expect(repo.setArchived).toHaveBeenLastCalledWith(db, "org-1", ID, false);
  });
});

describe("service: getForOrg", () => {
  it("returns the customer with related counts, 404 when missing", async () => {
    repo.findCustomer.mockResolvedValue(row());
    repo.countRelated.mockResolvedValue({ opportunities: 3, tasks: 0, quotes: 0 });
    expect(await getForOrg(db, ctx("viewer"), ID)).toMatchObject({
      id: ID,
      displayName: "Acme",
      related: { opportunities: 3, tasks: 0, quotes: 0 },
    });
    repo.findCustomer.mockResolvedValue(null);
    await expect(getForOrg(db, ctx("viewer"), ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});
