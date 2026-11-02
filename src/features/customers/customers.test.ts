import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, ValidationError } from "@/lib/api/errors";
import { parseQuery } from "@/lib/validation";
import { escapeLike } from "./repository";
import { createCustomerSchema, customerListQuery, toCustomerDto } from "./schema";
import { createForOrg, listForOrg } from "./service";

const parse = (body: unknown) => createCustomerSchema.safeParse(body);
const errorsOf = (body: unknown) => {
  const r = parse(body);
  if (r.success) return {};
  const out: Record<string, string[]> = {};
  for (const i of r.error.issues) (out[i.path.join(".") || "_form"] ??= []).push(i.message);
  return out;
};

describe("createCustomerSchema", () => {
  it("accepts the minimum (a name) and fills the defaults", () => {
    expect(parse({ displayName: "Acme Plumbing" })).toMatchObject({
      success: true,
      data: {
        type: "person",
        displayName: "Acme Plumbing",
        companyName: null,
        email: null,
        phone: null,
        website: null,
        status: "lead",
        source: "other",
        tags: [],
        notes: null,
        assignedTo: null,
      },
    });
  });
  it("normalizes: trims, lower-cases the e-mail, collapses duplicate tags, turns blanks into null", () => {
    const r = parse({
      displayName: "  Ada  Lovelace ".replace("  L", " L"),
      email: "  Ada@Example.COM ",
      tags: ["VIP", "vip", " repeat "],
      companyName: "   ",
      phone: "",
      notes: "  line one\r\nline two  ",
      assignedTo: "",
    });
    expect(r.success && r.data).toMatchObject({
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      tags: ["VIP", "repeat"],
      companyName: null,
      phone: null,
      notes: "line one\nline two",
      assignedTo: null,
    });
  });
  it.each([
    [{ displayName: "x" }, "displayName"],
    [{ displayName: "   " }, "displayName"],
    [{ displayName: "n".repeat(121) }, "displayName"],
    [{ displayName: "Ok", companyName: "c".repeat(121) }, "companyName"],
    [{ displayName: "Ok", email: "not-an-email" }, "email"],
    [{ displayName: "Ok", email: "a@b" }, "email"],
    [{ displayName: "Ok", phone: "1".repeat(41) }, "phone"],
    [{ displayName: "Ok", website: "javascript:alert(1)" }, "website"],
    [{ displayName: "Ok", website: "ftp://example.com" }, "website"],
    [{ displayName: "Ok", website: "https://user:pw@example.com" }, "website"],
    [{ displayName: "Ok", website: "https://example.com/" + "a".repeat(250) }, "website"],
    [{ displayName: "Ok", type: "robot" }, "type"],
    [{ displayName: "Ok", status: "won" }, "status"],
    [{ displayName: "Ok", source: "billboard" }, "source"],
    [{ displayName: "Ok", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, "tags"],
    [{ displayName: "Ok", tags: ["t".repeat(31)] }, "tags.0"],
    [{ displayName: "Ok", notes: "n".repeat(5001) }, "notes"],
    [{ displayName: "Ok", assignedTo: "not-a-uuid" }, "assignedTo"],
    [{ displayName: "<script>alert(1)</script>" }, "displayName"],
    [{ displayName: "Ok", notes: "<img src=x onerror=alert(1)>" }, "notes"],
    [{ displayName: "Bad\u0000Name" }, "displayName"],
    [{ displayName: "Two\nLines" }, "displayName"],
    [{}, "displayName"],
  ])("rejects %j with an error on %s", (body, field) => {
    expect(Object.keys(errorsOf(body))).toContain(field);
  });
  it("accepts the boundaries", () => {
    expect(parse({ displayName: "ab" }).success).toBe(true);
    expect(
      parse({
        displayName: "n".repeat(120),
        notes: "n".repeat(5000),
        tags: Array.from({ length: 10 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(true);
    expect(parse({ displayName: "Ok", tags: ["t".repeat(30)] }).success).toBe(true);
    expect(
      parse({ displayName: "Ok", website: "https://example.com/" + "a".repeat(235) }).success,
    ).toBe(true);
    expect(parse({ displayName: "a < b and c > d" }).success).toBe(true); // plain text with a bare "<"
  });
  it("refuses fields it does not know, so a tenant or creator cannot be injected", () => {
    for (const extra of [
      "organizationId",
      "organization_id",
      "createdBy",
      "created_by",
      "id",
      "archivedAt",
      "searchText",
      "createdAt",
    ]) {
      expect(parse({ displayName: "Ok", [extra]: "x" }).success, extra).toBe(false);
    }
  });
  it("counts length in code points (an emoji is one character, like the database)", () => {
    expect(parse({ displayName: "😀".repeat(120) }).success).toBe(true);
    expect(parse({ displayName: "😀".repeat(121) }).success).toBe(false);
  });
});

describe("customerListQuery", () => {
  const q = (qs: string) => parseQuery(customerListQuery, qs);
  it("defaults: page 1, limit 25, newest updated first, active only", () => {
    expect(q("")).toEqual({
      page: 1,
      limit: 25,
      sort: "updated_at",
      order: "desc",
      archived: "false",
    });
  });
  it("parses filters", () => {
    expect(
      q(
        "page=3&limit=50&sort=display_name&order=asc&q=acme&status=active&source=referral&archived=all&assignedTo=11111111-1111-4111-8111-111111111111",
      ),
    ).toMatchObject({
      page: 3,
      limit: 50,
      sort: "display_name",
      order: "asc",
      q: "acme",
      status: "active",
      source: "referral",
      archived: "all",
      assignedTo: "11111111-1111-4111-8111-111111111111",
    });
  });
  it.each([
    "limit=101",
    "limit=0",
    "page=0",
    "page=abc",
    "sort=password",
    "sort=display_name;drop",
    "order=sideways",
    "status=won",
    "source=x",
    "archived=maybe",
    "assignedTo=me",
    "nope=1",
    "limit=10&limit=20",
    "q=" + "x".repeat(101),
  ])("rejects %s with a 422", (qs) => {
    expect(() => q(qs)).toThrow(ValidationError);
  });
  it("treats an empty search as absent", () => {
    expect(q("q=&status=")).not.toHaveProperty("q");
  });
});

describe("escapeLike", () => {
  it("makes %, _ and backslash literal", () => {
    expect(escapeLike("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("toCustomerDto", () => {
  it("maps columns to camelCase and drops nothing it should keep", () => {
    const dto = toCustomerDto({
      id: "1",
      type: "company",
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
      created_at: "c",
      updated_at: "u2",
      archived_at: null,
    });
    expect(dto).toEqual({
      id: "1",
      type: "company",
      displayName: "Acme",
      companyName: null,
      email: "a@b.co",
      phone: null,
      website: null,
      status: "lead",
      source: "other",
      tags: ["x"],
      notes: null,
      assignedTo: null,
      createdBy: "u",
      createdAt: "c",
      updatedAt: "u2",
      archivedAt: null,
    });
  });
});

describe("service permissions", () => {
  const ctx = (role: string, kind = "real") =>
    ({ role, kind, org: { id: "org-1" }, user: { id: "u" } }) as never;
  const never = {
    from: vi.fn(() => {
      throw new Error("must not touch the database");
    }),
  } as never;
  const input = createCustomerSchema.parse({ displayName: "Acme" });
  it("a viewer cannot create: 403 before any database call", async () => {
    await expect(createForOrg(never, ctx("viewer"), input)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("an unknown role cannot do anything", async () => {
    await expect(createForOrg(never, ctx("intruder"), input)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listForOrg(never, ctx("intruder"), q0())).rejects.toBeInstanceOf(ForbiddenError);
  });
  function q0() {
    return parseQuery(customerListQuery, "");
  }
});
