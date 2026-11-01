import { describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("resolveRequestId", () => {
  it("generates a UUID when the caller sends none", () => {
    expect(resolveRequestId(new Headers())).toMatch(UUID);
  });

  it("generates a different ID each time", () => {
    expect(resolveRequestId(new Headers())).not.toBe(resolveRequestId(new Headers()));
  });

  it("accepts a safe caller-supplied ID so requests can be correlated", () => {
    const headers = new Headers({ [REQUEST_ID_HEADER]: "client-req_0123456789" });
    expect(resolveRequestId(headers)).toBe("client-req_0123456789");
    const uuid = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(resolveRequestId(new Headers({ [REQUEST_ID_HEADER]: uuid }))).toBe(uuid);
  });

  it.each([
    ["too short", "abc"],
    ["too long", "a".repeat(65)],
    ["contains a space", "has space inside"],
    ["contains a quote", 'id"with"quotes'],
    ["contains angle brackets", "<script>alert1</script>"],
    ["contains a slash", "a/b/c/d/e/f/g/h"],
    ["empty", ""],
  ])("replaces an unsafe ID (%s) instead of echoing it", (_label, value) => {
    const id = resolveRequestId(new Headers({ [REQUEST_ID_HEADER]: value }));
    expect(id).toMatch(UUID);
  });
});
