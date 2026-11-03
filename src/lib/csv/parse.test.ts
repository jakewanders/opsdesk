import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "./parse";

const fail = (text: string, limits?: Parameters<typeof parseCsv>[1]) => {
  try {
    parseCsv(text, limits);
  } catch (e) {
    return e as CsvError;
  }
  throw new Error("expected a CsvError");
};

describe("parseCsv", () => {
  it("reads a plain table", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });
  it("reads CRLF, lone CR and no trailing newline the same way", () => {
    const expected = [
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ];
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual(expected);
    expect(parseCsv("a,b\r1,2\r3,4\r")).toEqual(expected);
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual(expected);
  });
  it("drops a leading byte-order mark", () => {
    expect(parseCsv("﻿display_name,email\nAda,a@x.co")[0]).toEqual(["display_name", "email"]);
  });
  it("keeps commas, doubled quotes and line breaks inside quotes", () => {
    expect(parseCsv('name,notes\n"Smith, Ada","said ""hi""\nthen left"\n')).toEqual([
      ["name", "notes"],
      ["Smith, Ada", 'said "hi"\nthen left'],
    ]);
  });
  it("keeps CRLF inside a quoted cell as typed", () => {
    expect(parseCsv('a\n"x\r\ny"\n')[1]).toEqual(["x\r\ny"]);
  });
  it("keeps empty cells, including a trailing one", () => {
    expect(parseCsv("a,b,c\n1,,\n,,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
      ["", "", "3"],
    ]);
  });
  it("distinguishes a quoted empty cell from a blank line", () => {
    expect(parseCsv('a\n""\n\nb\n')).toEqual([["a"], [""], ["b"]]);
  });
  it("skips blank lines", () => {
    expect(parseCsv("a,b\n\n1,2\n\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("never interprets a cell: formula-looking text is plain text", () => {
    expect(
      parseCsv('a\n=HYPERLINK("http://x")\n"+1"\n@cmd\n-2\n')
        .slice(1)
        .map((r) => r[0]),
    ).toEqual(['=HYPERLINK("http://x")', "+1", "@cmd", "-2"]);
  });
  it("keeps a quote in the middle of an unquoted cell as a character", () => {
    expect(parseCsv('a\n5" pipe\n')[1]).toEqual(['5" pipe']);
  });
  it("rejects an empty file", () => {
    expect(fail("").code).toBe("EMPTY");
    expect(fail("\n\n").code).toBe("EMPTY");
    expect(fail("﻿").code).toBe("EMPTY");
  });
  it("rejects a quote that never closes", () => {
    expect(fail('a,b\n1,"oops\n2,3\n').code).toBe("UNTERMINATED_QUOTE");
  });
  it("accepts exactly the data-row limit and rejects one more", () => {
    const limits = { maxDataRows: 3, maxColumns: 5, maxCellLength: 20 };
    expect(parseCsv("h\n1\n2\n3\n", limits)).toHaveLength(4);
    const e = fail("h\n1\n2\n3\n4\n", limits);
    expect(e.code).toBe("TOO_MANY_ROWS");
  });
  it("stops at the row limit without reading the rest", () => {
    const limits = { maxDataRows: 2, maxColumns: 5, maxCellLength: 20 };
    const big = "h\n" + "x\n".repeat(200000);
    expect(fail(big, limits).code).toBe("TOO_MANY_ROWS");
  });
  it("enforces the column and cell limits", () => {
    const limits = { maxDataRows: 10, maxColumns: 3, maxCellLength: 5 };
    expect(fail("a,b,c,d\n", limits).code).toBe("TOO_MANY_COLUMNS");
    expect(parseCsv("a,b,c\n12345,1,1\n", limits)).toHaveLength(2);
    expect(fail("a\n123456\n", limits).code).toBe("CELL_TOO_LONG");
    expect(fail('a\n"123456"\n', limits).code).toBe("CELL_TOO_LONG");
  });
});
