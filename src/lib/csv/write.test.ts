import { describe, expect, it } from "vitest";
import { parseCsv } from "./parse";
import { CSV_BOM, csvRow, escapeCsvCell, neutralizeFormula } from "./write";

describe("escapeCsvCell: formula injection (PRD 11.1 CSV sanitization)", () => {
  it.each([
    ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ["\t=1+1", "'\t=1+1"],
    ["\r=1+1", `"'\r=1+1"`],
    ["\n=1+1", `"'\n=1+1"`],
    ["\u0000=1", "'\u0000=1"],
    ["\u001f+1", "'\u001f+1"],
    ["\u007f=1", "'\u007f=1"],
  ])("%j is written as inert text %j", (input, expected) => {
    expect(escapeCsvCell(input)).toBe(expected);
  });

  it("leaves ordinary text alone, including a formula character that is not first", () => {
    for (const text of [
      "Acme",
      "a=b",
      "x+y",
      "name@example.com",
      "5-2",
      " =1",
      "O'Brien",
      "",
      "ünï",
    ])
      expect(escapeCsvCell(text)).toBe(text);
  });

  it("a text cell that looks like a number is still text and is neutralized; a real number is not", () => {
    expect(escapeCsvCell("-5")).toBe("'-5");
    expect(escapeCsvCell(-5)).toBe("-5");
    expect(escapeCsvCell(1234)).toBe("1234");
    expect(escapeCsvCell(Number.NaN)).toBe("");
    expect(escapeCsvCell(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("null, undefined and booleans", () => {
    expect(escapeCsvCell(null)).toBe("");
    expect(escapeCsvCell(undefined)).toBe("");
    expect(escapeCsvCell(true)).toBe("true");
    expect(escapeCsvCell(false)).toBe("false");
  });

  it("neutralizeFormula is idempotent in effect on safe text and adds exactly one quote", () => {
    expect(neutralizeFormula("=1")).toBe("'=1");
    expect(neutralizeFormula("'=1")).toBe("'=1");
  });
});

describe("escapeCsvCell: RFC 4180 quoting", () => {
  it("quotes commas, quotes, CR and LF, and doubles inner quotes", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(escapeCsvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
  });
  it("csvRow joins with commas and ends with CRLF", () => {
    expect(csvRow(["a", 1, null, "b,c"])).toBe('a,1,,"b,c"\r\n');
  });
  it("exposes the UTF-8 byte-order mark", () => {
    expect(CSV_BOM).toBe("﻿");
    expect(Array.from(new TextEncoder().encode(CSV_BOM))).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("round trip through the project's own CSV reader", () => {
  it("every awkward cell reads back as the original text, with one leading quote on a neutralized one", () => {
    const cells = [
      '=HYPERLINK("http://x")',
      "+1+1",
      "@SUM(A1)",
      "\t=1+1",
      "a,b",
      'q"uote',
      "two\nlines",
      "Üñí",
      "",
    ];
    const file =
      CSV_BOM + csvRow(["h1", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9"]) + csvRow(cells);
    const parsed = parseCsv(file);
    const row = parsed[1];
    const expected = cells.map((c) => neutralizeFormula(c));
    expect(row).toEqual(expected);
  });
});
