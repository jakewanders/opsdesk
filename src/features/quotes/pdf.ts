import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PdfDocument,
  textWidth,
  wrapText,
  type PdfPage,
} from "@/lib/pdf/document";
import { formatTaxRate } from "@/lib/domain/quotes";
import { formatUsd } from "@/lib/money/format";
import type { QuoteDetailDto } from "./schema";

const MARGIN = 54;
const RIGHT = PAGE_WIDTH - MARGIN;
const BOTTOM = PAGE_HEIGHT - 72;
const COL = { qty: 380, price: 462, total: RIGHT } as const; // right edges of the numeric columns
const DESC_WIDTH = 270;
export const WATERMARK = "Sample / fictional data";

const STATUS = {
  draft: "Draft",
  sent: "Sent",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
} as const;
const DAY = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const day = (iso: string) => DAY.format(new Date(`${iso}T00:00:00Z`));

export type QuotePdfOptions = {
  /** A demo workspace: every page carries the watermark. */
  demo: boolean;
  /** The workspace's name, shown as who the quote is from. */
  organizationName: string;
};

/**
 * The printable quote (PRD 8.2, US-08). Everything on it is the server's stored data: amounts are the saved cents formatted with the
 * shared formatter and nothing is recomputed. Deterministic: no dates of its own and no random ids, so the same quote always gives the
 * same bytes. A demo's pages are marked "Sample / fictional data" in a large diagonal and in the footer.
 */
export function renderQuotePdf(quote: QuoteDetailDto, options: QuotePdfOptions): Uint8Array {
  const doc = new PdfDocument({ title: `Quote ${quote.quoteNumber}`, subject: quote.title });

  const header = (page: PdfPage) => {
    page.text(MARGIN, 66, "OpsDesk", { size: 22, face: "bold" });
    page.text(MARGIN, 82, "Business operations, in one place", { size: 9, gray: 0.4 });
    page.text(RIGHT, 62, "QUOTE", { size: 11, face: "bold", gray: 0.4, align: "right" });
    page.text(RIGHT, 82, quote.quoteNumber, { size: 18, face: "bold", align: "right" });
    page.line(MARGIN, 96, RIGHT, 96, { width: 1.5, gray: 0.2 });
  };
  const begin = (): PdfPage => {
    const page = doc.addPage();
    header(page);
    return page;
  };

  let page = begin();
  let y = 122;

  // title and who it is for
  page.text(MARGIN, y, quote.title, { size: 15, face: "bold" });
  y += 24;
  const meta: Array<[string, string]> = [
    ["Prepared by", options.organizationName],
    ["Customer", quote.customerName ?? "Unknown customer"],
    ["Status", STATUS[quote.status]],
    ["Issue date", day(quote.issueDate)],
    ["Valid until", quote.validUntil ? day(quote.validUntil) : "No end date"],
  ];
  for (const [label, value] of meta) {
    page.text(MARGIN, y, label, { size: 9, gray: 0.4 });
    for (const line of wrapText(value, 380, 10)) {
      page.text(MARGIN + 90, y, line, { size: 10 });
      y += 14;
    }
  }
  y += 14;

  // line items
  const tableHeader = (p: PdfPage) => {
    p.rect(MARGIN, y - 12, RIGHT - MARGIN, 20, 0.93);
    p.text(MARGIN + 6, y + 2, "Description", { size: 9, face: "bold" });
    p.text(COL.qty, y + 2, "Qty", { size: 9, face: "bold", align: "right" });
    p.text(COL.price, y + 2, "Unit price", { size: 9, face: "bold", align: "right" });
    p.text(COL.total - 6, y + 2, "Line total", { size: 9, face: "bold", align: "right" });
    y += 24;
  };
  tableHeader(page);
  for (const item of quote.items) {
    const lines = wrapText(item.description, DESC_WIDTH, 10);
    const height = lines.length * 13 + 8;
    if (y + height > BOTTOM) {
      page = begin();
      y = 122;
      tableHeader(page);
    }
    lines.forEach((line, i) => page.text(MARGIN + 6, y + i * 13, line, { size: 10 }));
    page.text(COL.qty, y, item.quantity.toLocaleString("en-US"), { size: 10, align: "right" });
    page.text(COL.price, y, formatUsd(item.unitPriceCents), { size: 10, align: "right" });
    page.text(COL.total - 6, y, formatUsd(item.lineTotalCents), { size: 10, align: "right" });
    y += height;
    page.line(MARGIN, y - 8, RIGHT, y - 8, { gray: 0.88 });
  }

  // totals
  const totals: Array<[string, string, boolean]> = [
    ["Subtotal", formatUsd(quote.subtotalCents), false],
  ];
  if (quote.discountCents > 0)
    totals.push(["Discount", `-${formatUsd(quote.discountCents)}`, false]);
  totals.push([`Tax (${formatTaxRate(quote.taxRateBps)})`, formatUsd(quote.taxCents), false]);
  totals.push(["Total", formatUsd(quote.totalCents), true]);
  if (y + totals.length * 20 + 20 > BOTTOM) {
    page = begin();
    y = 122;
  }
  y += 6;
  for (const [label, value, strong] of totals) {
    if (strong) page.line(COL.price - 90, y - 12, RIGHT, y - 12, { width: 1, gray: 0.2 });
    page.text(COL.price - 6, y, label, {
      size: strong ? 12 : 10,
      face: strong ? "bold" : "regular",
      align: "right",
    });
    page.text(COL.total - 6, y, value, {
      size: strong ? 12 : 10,
      face: strong ? "bold" : "regular",
      align: "right",
    });
    y += strong ? 22 : 18;
  }

  // notes
  if (quote.notes) {
    y += 14;
    const noteLines = wrapText(quote.notes, RIGHT - MARGIN, 10);
    if (y + 20 > BOTTOM) {
      page = begin();
      y = 122;
    }
    page.text(MARGIN, y, "Notes", { size: 10, face: "bold" });
    y += 16;
    for (const line of noteLines) {
      if (y > BOTTOM) {
        page = begin();
        y = 122;
      }
      page.text(MARGIN, y, line, { size: 10 });
      y += 13;
    }
  }

  // footer (and the watermark, in a demo) on every page
  const count = doc.pages.length;
  doc.pages.forEach((p, i) => {
    p.line(MARGIN, PAGE_HEIGHT - 54, RIGHT, PAGE_HEIGHT - 54);
    p.text(MARGIN, PAGE_HEIGHT - 40, `${quote.quoteNumber} - Generated by OpsDesk`, {
      size: 8,
      gray: 0.4,
    });
    p.text(RIGHT, PAGE_HEIGHT - 40, `Page ${i + 1} of ${count}`, {
      size: 8,
      gray: 0.4,
      align: "right",
    });
    if (options.demo) {
      p.text(PAGE_WIDTH / 2, PAGE_HEIGHT - 28, WATERMARK, {
        size: 8,
        face: "bold",
        gray: 0.4,
        align: "center",
      });
      // a large diagonal mark, drawn last but light enough to read the page through it
      const size = 54;
      const w = textWidth(WATERMARK, size, "bold");
      const rad = (35 * Math.PI) / 180;
      p.text(
        PAGE_WIDTH / 2 - (w / 2) * Math.cos(rad),
        PAGE_HEIGHT / 2 + (w / 2) * Math.sin(rad),
        WATERMARK,
        {
          size,
          face: "bold",
          gray: 0.86,
          rotate: 35,
        },
      );
    }
  });
  return doc.toBytes();
}
