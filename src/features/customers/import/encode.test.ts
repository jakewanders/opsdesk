import { describe, expect, it } from "vitest";
import { bytesToBase64, checkChosenFile } from "./encode";
import { planImport } from "./types";

describe("bytesToBase64", () => {
  it("matches Buffer's base64 for small and large inputs", () => {
    for (const n of [0, 1, 2, 3, 100, 40_000, 2 * 1024 * 1024]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
      expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });
});

describe("checkChosenFile", () => {
  const ok = { name: "customers.csv", size: 1000, type: "text/csv" };
  it("accepts a .csv file or a CSV media type", () => {
    expect(checkChosenFile(ok)).toBeNull();
    expect(checkChosenFile({ ...ok, name: "export.CSV", type: "" })).toBeNull();
    expect(checkChosenFile({ ...ok, name: "export", type: "application/vnd.ms-excel" })).toBeNull();
  });
  it("refuses other kinds of file, empty files and files over 2 MB", () => {
    expect(checkChosenFile({ ...ok, name: "photo.png", type: "image/png" })).toMatch(/CSV file/);
    expect(checkChosenFile({ ...ok, name: "notes.txt", type: "text/plain" })).toMatch(/CSV file/);
    expect(checkChosenFile({ ...ok, size: 0 })).toMatch(/empty/);
    expect(checkChosenFile({ ...ok, size: 2 * 1024 * 1024 })).toBeNull();
    expect(checkChosenFile({ ...ok, size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
  });
});

describe("planImport", () => {
  const w = (row: number, code: string) => ({ row, field: "email", code, message: "x" });
  it("counts rows that repeat an email once, however many warnings they have", () => {
    const plan = planImport({
      counts: { total: 10, valid: 8, invalid: 2 },
      warnings: [w(3, "DUPLICATE_IN_FILE"), w(3, "DUPLICATE_EXISTING"), w(5, "DUPLICATE_EXISTING")],
      warningsTruncated: false,
      demo: null,
    });
    expect(plan).toMatchObject({
      invalid: 2,
      duplicateRows: 2,
      willImport: 6,
      overDemoCap: 0,
      duplicatesApproximate: false,
    });
  });
  it("limits a demo to the room it has", () => {
    const plan = planImport({
      counts: { total: 100, valid: 100, invalid: 0 },
      warnings: [],
      warningsTruncated: false,
      demo: { remaining: 32, wouldExceed: true },
    });
    expect(plan).toMatchObject({ willImport: 32, overDemoCap: 68 });
  });
  it("says when the duplicate count is only a floor", () => {
    expect(
      planImport({
        counts: { total: 1, valid: 1, invalid: 0 },
        warnings: [],
        warningsTruncated: true,
        demo: null,
      }).duplicatesApproximate,
    ).toBe(true);
  });
  it("never goes below zero", () => {
    expect(
      planImport({
        counts: { total: 2, valid: 1, invalid: 1 },
        warnings: [w(2, "DUPLICATE_IN_FILE"), w(3, "DUPLICATE_IN_FILE")],
        warningsTruncated: false,
        demo: null,
      }).willImport,
    ).toBe(0);
  });
});
