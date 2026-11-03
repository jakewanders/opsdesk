import { beforeEach, describe, expect, it } from "vitest";
import { LIST_ROUTES, recallList, rememberList, safeListUrl } from "./list-memory";

describe("safeListUrl: only a path of the list's own route comes back", () => {
  it("accepts the route and the route with a query", () => {
    expect(safeListUrl("customers", "/app/customers")).toBe("/app/customers");
    expect(safeListUrl("customers", "/app/customers?q=acme&status=lead&page=2")).toBe(
      "/app/customers?q=acme&status=lead&page=2",
    );
  });
  it.each([
    "https://evil.example/app/customers",
    "//evil.example",
    "/app/customers/../settings",
    "/app/customersX",
    "/app/customers/123",
    "/app/tasks?q=x",
    "/app/customers?next=//evil.example",
    "/app/customers?x=\\evil",
    "/app/customers?x=\u0000",
    "javascript:alert(1)",
    "",
    "/app/customers?" + "a".repeat(700),
  ])("refuses %j", (value) => {
    expect(safeListUrl("customers", value)).toBeNull();
  });
  it("refuses non-strings", () => {
    expect(safeListUrl("customers", null)).toBeNull();
    expect(safeListUrl("customers", 42)).toBeNull();
  });
});

describe("remember and recall", () => {
  beforeEach(() => window.sessionStorage.clear());
  it("recalls what a list page remembered, per list", () => {
    rememberList("customers", "/app/customers?q=acme");
    rememberList("tasks", "/app/tasks?overdue=true");
    expect(recallList("customers")).toBe("/app/customers?q=acme");
    expect(recallList("tasks")).toBe("/app/tasks?overdue=true");
    expect(recallList("quotes")).toBe(LIST_ROUTES.quotes);
  });
  it("falls back to the plain list when nothing, or something tampered with, is stored", () => {
    expect(recallList("customers")).toBe("/app/customers");
    window.sessionStorage.setItem("opsdesk:list:customers", "https://evil.example");
    expect(recallList("customers")).toBe("/app/customers");
  });
  it("does not store an unsafe value", () => {
    rememberList("customers", "//evil.example");
    expect(window.sessionStorage.getItem("opsdesk:list:customers")).toBeNull();
  });
  it("survives storage being blocked", () => {
    const spy = (name: "getItem" | "setItem") =>
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: {
          getItem: () => {
            throw new Error("blocked");
          },
          setItem: () => {
            throw new Error("blocked");
          },
          [name]: undefined,
        },
      });
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage")!;
    spy("getItem");
    expect(() => rememberList("customers", "/app/customers?q=a")).not.toThrow();
    expect(recallList("customers")).toBe("/app/customers");
    Object.defineProperty(window, "sessionStorage", original);
  });
});
