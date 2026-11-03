import { describe, expect, it } from "vitest";
import { analyzeConflict, changedKeys, listLabels, mergeOnTop, summarizeMine } from "./conflict";

type V = { name: string; phone: string; tags: string[]; notes: string };
const KEYS = ["name", "phone", "tags", "notes"] as const;
const base: V = { name: "Acme", phone: "", tags: ["a"], notes: "" };

describe("changedKeys", () => {
  it("lists the differing keys in the given order, comparing arrays by content and null as empty", () => {
    expect(changedKeys(base, { ...base, tags: ["a"] }, KEYS)).toEqual([]);
    expect(changedKeys(base, { ...base, tags: ["a", "b"], name: "Acme 2" }, KEYS)).toEqual([
      "name",
      "tags",
    ]);
    // null and "" are different values for the server, so a null that comes back as "" counts as a change
    expect(changedKeys({ ...base, phone: null as unknown as string }, base, KEYS)).toEqual([
      "phone",
    ]);
  });
  it("an empty string is not the same as a changed value", () => {
    expect(changedKeys(base, { ...base, phone: "555" }, KEYS)).toEqual(["phone"]);
  });
});

describe("analyzeConflict", () => {
  it("different fields: nothing overlaps and my changes can go on top", () => {
    const a = analyzeConflict(base, { ...base, name: "Mine" }, { ...base, phone: "555" }, KEYS);
    expect(a).toEqual({ byOthers: ["phone"], mine: ["name"], overlap: [], canApplyOnTop: true });
  });
  it("the same field changed to different values is an overlap and cannot go on top", () => {
    const a = analyzeConflict(base, { ...base, name: "Mine" }, { ...base, name: "Theirs" }, KEYS);
    expect(a.overlap).toEqual(["name"]);
    expect(a.canApplyOnTop).toBe(false);
  });
  it("the same field changed to the SAME value is not a conflict", () => {
    const a = analyzeConflict(base, { ...base, name: "Same" }, { ...base, name: "Same" }, KEYS);
    expect(a.overlap).toEqual([]);
    expect(a.canApplyOnTop).toBe(true);
  });
  it("an array field is compared by content", () => {
    const a = analyzeConflict(
      base,
      { ...base, tags: ["a", "x"] },
      { ...base, tags: ["a", "y"] },
      KEYS,
    );
    expect(a.overlap).toEqual(["tags"]);
  });
  it("with nothing of mine changed there is nothing to apply", () => {
    const a = analyzeConflict(base, base, { ...base, name: "Theirs" }, KEYS);
    expect(a).toMatchObject({ mine: [], byOthers: ["name"], canApplyOnTop: false });
  });
  it("only the listed keys count (a derived field that differs is ignored)", () => {
    const a = analyzeConflict({ ...base, x: 1 }, { ...base, x: 2 }, { ...base, x: 3 }, KEYS);
    expect(a.byOthers).toEqual([]);
    expect(a.mine).toEqual([]);
  });
});

describe("mergeOnTop", () => {
  it("lays my changed fields over the latest and leaves the rest as the server has them", () => {
    const merged = mergeOnTop({ ...base, phone: "555", name: "Acme" }, { ...base, name: "Mine" }, [
      "name",
    ]);
    expect(merged).toEqual({ name: "Mine", phone: "555", tags: ["a"], notes: "" });
  });
});

describe("text helpers", () => {
  const labels = { name: "Name", phone: "Phone", tags: "Tags", notes: "Notes" };
  it("listLabels reads like a sentence", () => {
    expect(listLabels(labels, [])).toBe("");
    expect(listLabels(labels, ["name"])).toBe("Name");
    expect(listLabels(labels, ["name", "phone"])).toBe("Name and Phone");
    expect(listLabels(labels, ["name", "phone", "notes"])).toBe("Name, Phone and Notes");
    expect(listLabels(labels, ["unknown"])).toBe("unknown");
  });
  it("summarizeMine is the person's own values, one field per line, arrays joined", () => {
    expect(
      summarizeMine(labels, { ...base, name: "Mine", tags: ["a", "b"] }, ["name", "tags"]),
    ).toBe("Name: Mine\nTags: a; b");
  });
});
