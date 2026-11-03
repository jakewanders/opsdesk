/**
 * A small PDF writer for one kind of document: text, lines and rectangles on US Letter pages, set in the built-in Helvetica faces.
 * Written by hand on purpose (SIT-247): no dependency to audit or bundle, no font files, no network, and byte-for-byte deterministic
 * output (no dates, no random ids), which is what the tests rely on. Streams are left uncompressed so the text can be read back.
 *
 * Text is encoded as WinAnsi. Accented Latin letters are written as their plain letters, typographic quotes and dashes as ASCII, and
 * anything else the standard fonts cannot draw as "?". Every string is escaped, so no input can break out of its string.
 */
export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

export type Face = "regular" | "bold";

/** Advance widths of Helvetica and Helvetica-Bold for ASCII 32 to 126, in 1/1000 em (the standard AFM metrics). */
const WIDTHS: Record<Face, number[]> = {
  regular: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ],
  bold: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ],
};

/** Plain text the standard fonts can draw: accents folded away, typographic punctuation made ASCII, control characters dropped. */
export function toPdfText(input: string): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/[\t\r\n]+/g, " ");
  let out = "";
  for (const ch of folded) {
    const code = ch.codePointAt(0)!;
    out += code >= 32 && code <= 126 ? ch : code < 32 || code === 127 ? "" : "?";
  }
  return out;
}

/** The width of `text` in points at `size`. */
export function textWidth(text: string, size: number, face: Face = "regular"): number {
  let units = 0;
  for (const ch of toPdfText(text)) units += WIDTHS[face][ch.charCodeAt(0) - 32] ?? 556;
  return (units * size) / 1000;
}

/** Breaks `text` into lines no wider than `maxWidth`; a single word wider than that is cut. */
export function wrapText(text: string, maxWidth: number, size: number, face: Face = "regular") {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r\n|\r|\n/)) {
    let line = "";
    const flush = () => {
      lines.push(line);
      line = "";
    };
    for (const word of toPdfText(paragraph).split(" ").filter(Boolean)) {
      let w = word;
      while (textWidth(w, size, face) > maxWidth) {
        let cut = w.length - 1;
        while (cut > 1 && textWidth(w.slice(0, cut), size, face) > maxWidth) cut--;
        if (line) flush();
        lines.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = line ? `${line} ${w}` : w;
      if (line && textWidth(candidate, size, face) > maxWidth) {
        flush();
        line = w;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

const escapeString = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export type TextOptions = {
  size?: number;
  face?: Face;
  /** 0 (black) to 1 (white). */
  gray?: number;
  align?: "left" | "right" | "center";
  /** Counter-clockwise rotation about the text origin, in degrees. */
  rotate?: number;
};

/** One page: operations are written in reading order with y measured from the TOP of the page. */
export class PdfPage {
  readonly ops: string[] = [];

  text(x: number, y: number, text: string, o: TextOptions = {}) {
    const { size = 10, face = "regular", gray = 0, align = "left", rotate = 0 } = o;
    const safe = toPdfText(text);
    const w = textWidth(safe, size, face);
    const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    const rad = (rotate * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    // with a rotation the alignment offset runs along the baseline
    const px = rotate ? x + (left - x) * c : left;
    const py = PAGE_HEIGHT - y + (rotate ? (left - x) * s : 0);
    this.ops.push(
      `BT /${face === "bold" ? "F2" : "F1"} ${num(size)} Tf ${num(gray)} g ${num(c)} ${num(s)} ${num(-s)} ${num(c)} ${num(px)} ${num(py)} Tm (${escapeString(safe)}) Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, o: { width?: number; gray?: number } = {}) {
    const { width = 0.5, gray = 0.8 } = o;
    this.ops.push(
      `${num(gray)} G ${num(width)} w ${num(x1)} ${num(PAGE_HEIGHT - y1)} m ${num(x2)} ${num(PAGE_HEIGHT - y2)} l S`,
    );
  }

  rect(x: number, y: number, w: number, h: number, gray: number) {
    this.ops.push(`${num(gray)} g ${num(x)} ${num(PAGE_HEIGHT - y - h)} ${num(w)} ${num(h)} re f`);
  }
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  constructor(private readonly info: { title: string; subject?: string } = { title: "Document" }) {}

  addPage(): PdfPage {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }

  /** The finished file. */
  toBytes(): Uint8Array {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body) && objects.length;
    // 1 catalog, 2 pages, 3 and 4 fonts, 5 info; then a content stream and a page object per page
    const pageCount = Math.max(this.pages.length, 1);
    const firstPageObj = 6;
    const kids = Array.from({ length: pageCount }, (_, i) => `${firstPageObj + i * 2 + 1} 0 R`);
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`);
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    add(
      `<< /Title (${escapeString(toPdfText(this.info.title))}) /Subject (${escapeString(toPdfText(this.info.subject ?? ""))}) /Producer (OpsDesk) >>`,
    );
    const pages = this.pages.length ? this.pages : [new PdfPage()];
    for (const page of pages) {
      const stream = page.ops.join("\n");
      add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objects.length} 0 R >>`,
      );
    }
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Uint8Array.from(out, (ch) => ch.charCodeAt(0) & 0xff);
  }
}

/** The text of a PDF made by this writer, page by page (for tests and for checking what a download says). */
export function extractPdfText(bytes: Uint8Array): string[] {
  const source = Buffer.from(bytes).toString("latin1");
  return [...source.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) =>
    [...m[1].matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)]
      .map((t) => t[1].replace(/\\(.)/g, "$1"))
      .join("\n"),
  );
}
