import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plan = readFileSync("docs/IMPLEMENTATION_PLAN.md", "utf8");

/** Rows of the features table: `| F01 | ... |` split into trimmed cells. */
const rows = plan
  .split("\n")
  .filter((line) => /^\| F\d{2} /.test(line))
  .map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );

describe("docs/IMPLEMENTATION_PLAN.md", () => {
  it("has a row for every P0/P1 feature F01 to F17, in order", () => {
    expect(rows.map((r) => r[0])).toEqual(
      Array.from({ length: 17 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`),
    );
  });

  it.each(rows.map((r) => [r[0], r] as const))(
    "%s has files, migrations, tests, and issues",
    (_id, row) => {
      const [, feature, files, migrations, tests, issues] = row;
      expect(row).toHaveLength(6);
      for (const cell of [feature, files, migrations, tests, issues]) {
        expect(cell.length).toBeGreaterThan(0);
      }
      expect(issues).toMatch(/SIT-\d+|P-\d+/);
    },
  );

  it("does not claim anything is complete in any table row", () => {
    const tableLines = plan.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines.join("\n")).not.toMatch(/\b(done|completed|passing|passed)\b|✅/i);
  });

  it("covers every created issue named in the matrix's feature areas at least once", () => {
    for (const issue of [
      "SIT-164",
      "SIT-199",
      "SIT-208",
      "SIT-216",
      "SIT-220",
      "SIT-244",
      "SIT-222",
      "SIT-202",
      "SIT-264",
      "SIT-239",
      "SIT-213",
    ]) {
      expect(plan).toContain(issue);
    }
  });
});
