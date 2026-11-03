import { describe, expect, it } from "vitest";
import { extractPdfText, PdfDocument, textWidth, toPdfText, wrapText } from "./document";

const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

describe("PdfDocument", () => {
  const make = () => {
    const doc = new PdfDocument({ title: "Test (title)" });
    const page = doc.addPage();
    page.text(50, 50, "Hello (world) \\ done", { size: 12, face: "bold" });
    page.line(50, 60, 200, 60);
    page.rect(50, 70, 100, 20, 0.9);
    doc.addPage().text(50, 50, "Second page");
    return doc.toBytes();
  };

  it("is a well-formed file: header, trailer, and an xref whose offsets point at the objects", () => {
    const text = latin1(make());
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe("xref");
    const entries = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(entries.length).toBeGreaterThan(5);
    entries.forEach((offset, i) =>
      expect(text.slice(offset, offset + 8)).toMatch(new RegExp(`^${i + 1} 0 obj`)),
    );
    expect(text).toMatch(/\/Count 2/);
  });
  it("is deterministic: the same document gives the same bytes", () => {
    expect(Buffer.from(make()).equals(Buffer.from(make()))).toBe(true);
  });
  it("escapes parentheses and backslashes, so text can never leave its string", () => {
    const [first] = extractPdfText(make());
    expect(first).toContain("Hello (world) \\ done");
    const raw = latin1(make());
    expect(raw).toContain("(Hello \\(world\\) \\\\ done) Tj");
    expect(raw).toContain("/Title (Test \\(title\\))");
  });
  it("reads back page by page", () => {
    expect(extractPdfText(make())).toEqual(["Hello (world) \\ done", "Second page"]);
  });
  it("makes an empty document still valid (one blank page)", () => {
    const text = latin1(new PdfDocument().toBytes());
    expect(text).toMatch(/\/Count 1/);
  });
});

describe("text handling", () => {
  it("folds accents and typographic punctuation, drops control characters, and marks the rest", () => {
    expect(toPdfText("Café “Zoë” – naïve…")).toBe('Cafe "Zoe" - naive...');
    expect(toPdfText("a\u0000b\tc\nd")).toBe("ab c d");
    expect(toPdfText("日本")).toBe("??");
  });
  it("measures with the Helvetica metrics (bold is wider)", () => {
    expect(textWidth("iiii", 10)).toBeCloseTo(8.88, 2);
    expect(textWidth("Total", 10, "bold")).toBeGreaterThan(textWidth("Total", 10));
    expect(textWidth("", 10)).toBe(0);
  });
  it("wraps on words, keeps blank lines, and cuts a word that is wider than the line", () => {
    const lines = wrapText("one two three four five six seven eight nine ten", 80, 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(80);
    expect(wrapText("a\n\nb", 100, 10)).toEqual(["a", "", "b"]);
    const cut = wrapText("x".repeat(100), 50, 10);
    expect(cut.length).toBeGreaterThan(1);
    expect(cut.join("")).toBe("x".repeat(100));
  });
});
