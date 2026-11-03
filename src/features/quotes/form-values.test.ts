import { describe, expect, it } from "vitest";
import { calculateQuote } from "@/lib/domain/quotes";
import {
  buildPayload,
  compareWithServer,
  EMPTY_QUOTE,
  moveItem,
  parseQuantity,
  quotePreview,
  toQuoteFormValues,
  type QuoteFormValues,
} from "./form-values";
import type { QuoteDetailDto } from "./schema";

const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const values = (over: Partial<QuoteFormValues> = {}): QuoteFormValues => ({
  ...EMPTY_QUOTE,
  customerId: CUSTOMER,
  title: "Kitchen rewiring",
  items: [
    { description: "Widget", quantity: "2", unitPrice: "19.99" },
    { description: "Gadget", quantity: "1", unitPrice: "50.00" },
  ],
  discount: "5.00",
  taxRate: "8.25",
  ...over,
});

describe("parseQuantity", () => {
  it("accepts whole numbers from 1 to 100,000 and refuses the rest with a message", () => {
    expect(parseQuantity("1")).toEqual({ ok: true, quantity: 1 });
    expect(parseQuantity(" 100000 ")).toEqual({ ok: true, quantity: 100000 });
    for (const bad of ["", "0", "100001", "1.5", "-1", "1e3", "abc", "12345678901"]) {
      expect(parseQuantity(bad).ok, bad).toBe(false);
    }
  });
});

describe("the live preview", () => {
  it("is the shared calculation: 2 x 19.99 + 50.00 less 5.00 at 8.25% is 91.99", () => {
    const p = quotePreview(values());
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.totals).toMatchObject({ subtotalCents: 8998, taxCents: 701, totalCents: 9199 });
    }
  });

  const fixtures: Array<{
    price: string;
    qty: string;
    discount: string;
    rate: string;
    cents: [number, number, number];
  }> = [
    { price: "50.00", qty: "1", discount: "0", rate: "0.01", cents: [5000, 1, 5001] }, // 0.5 cents of tax goes up
    { price: "49.99", qty: "1", discount: "0", rate: "0.01", cents: [4999, 0, 4999] }, // 0.4999 stays down
    { price: "0.25", qty: "1", discount: "0", rate: "10", cents: [25, 3, 28] }, // 2.5 cents goes up to 3
    { price: "0.15", qty: "1", discount: "0", rate: "10", cents: [15, 2, 17] }, // 1.5 goes up to 2 (not to even)
    { price: "0.05", qty: "1", discount: "0", rate: "10", cents: [5, 1, 6] }, // 0.5 goes up to 1
    { price: "3.00", qty: "3", discount: "9.00", rate: "8.25", cents: [900, 0, 0] }, // discount equals subtotal
    {
      price: "1,234.56",
      qty: "100",
      discount: "0",
      rate: "100",
      cents: [12345600, 12345600, 24691200],
    },
    {
      price: "1000000.00",
      qty: "100000",
      discount: "0",
      rate: "0",
      cents: [10000000000000, 0, 10000000000000],
    },
  ];
  it.each(fixtures)("fixture $price x $qty at $rate%", ({ price, qty, discount, rate, cents }) => {
    const p = quotePreview(
      values({
        items: [{ description: "Item", quantity: qty, unitPrice: price }],
        discount,
        taxRate: rate,
      }),
    );
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // the preview IS the shared module: compare with a direct call, then with the hand-checked numbers
    const direct = calculateQuote({
      lines: [
        {
          quantity: Number(qty),
          unitPriceCents: Math.round(Number(price.replace(/,/g, "")) * 100),
        },
      ],
      discountCents: Math.round(Number(discount) * 100),
      taxRateBps: Math.round(Number(rate) * 100),
    });
    expect([p.totals.subtotalCents, p.totals.taxCents, p.totals.totalCents]).toEqual([
      direct.subtotalCents,
      direct.taxCents,
      direct.totalCents,
    ]);
    expect([p.totals.subtotalCents, p.totals.taxCents, p.totals.totalCents]).toEqual(cents);
  });

  it("is not available while anything is invalid, rather than showing wrong numbers", () => {
    expect(
      quotePreview(values({ items: [{ description: "Widget", quantity: "0", unitPrice: "1.00" }] }))
        .ok,
    ).toBe(false);
    expect(
      quotePreview(values({ items: [{ description: "Widget", quantity: "1", unitPrice: "abc" }] }))
        .ok,
    ).toBe(false);
    expect(quotePreview(values({ discount: "999.00" })).ok).toBe(false); // above the subtotal
    expect(quotePreview(values({ taxRate: "100.01" })).ok).toBe(false);
    expect(quotePreview(values({ items: [] })).ok).toBe(false);
  });
});

describe("buildPayload", () => {
  it("creates the request body: integer cents and basis points, no totals", () => {
    const built = buildPayload(values({ validUntil: "2026-12-31", notes: "Net 30" }), {
      mode: "create",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body).toMatchObject({
      customerId: CUSTOMER,
      opportunityId: null,
      title: "Kitchen rewiring",
      taxRateBps: 825,
      discountCents: 500,
      validUntil: "2026-12-31",
      notes: "Net 30",
      items: [
        { description: "Widget", quantity: 2, unitPriceCents: 1999 },
        { description: "Gadget", quantity: 1, unitPriceCents: 5000 },
      ],
    });
    for (const forbidden of ["totalCents", "subtotalCents", "taxCents", "quoteNumber", "status"]) {
      expect(built.body).not.toHaveProperty(forbidden);
    }
  });

  it("an edit carries the version the quote was loaded at", () => {
    const built = buildPayload(values({ issueDate: "2026-11-02" }), { mode: "edit", version: 3 });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.body).toMatchObject({ expectedVersion: 3, issueDate: "2026-11-02" });
  });

  it("names every problem on its own control and line", () => {
    const built = buildPayload(
      values({
        customerId: "",
        title: "x",
        discount: "-1",
        taxRate: "abc",
        items: [
          { description: "", quantity: "0", unitPrice: "" },
          { description: "Fine", quantity: "2", unitPrice: "1.001" },
          { description: "Ok", quantity: "1", unitPrice: "2.00" },
        ],
      }),
      { mode: "create" },
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.problems.header).sort()).toEqual([
      "customerId",
      "discount",
      "taxRate",
      "title",
    ]);
    expect(Object.keys(built.problems.lines[0]).sort()).toEqual([
      "description",
      "quantity",
      "unitPrice",
    ]);
    expect(Object.keys(built.problems.lines[1])).toEqual(["unitPrice"]);
    expect(built.problems.lines[2]).toEqual({});
  });

  it("refuses a discount above the subtotal, no lines, over-range numbers and a bad date", () => {
    expect(buildPayload(values({ discount: "100.00" }), { mode: "create" })).toMatchObject({
      ok: false,
      problems: { header: { discount: expect.stringMatching(/subtotal/i) } },
    });
    expect(buildPayload(values({ items: [] }), { mode: "create" })).toMatchObject({
      ok: false,
      problems: { items: "Add at least one line item." },
    });
    expect(
      buildPayload(
        values({ items: [{ description: "Widget", quantity: "100001", unitPrice: "1.00" }] }),
        { mode: "create" },
      ).ok,
    ).toBe(false);
    expect(
      buildPayload(
        values({ items: [{ description: "Widget", quantity: "1", unitPrice: "1,000,000.01" }] }),
        { mode: "create" },
      ).ok,
    ).toBe(false);
    expect(buildPayload(values({ taxRate: "100.01" }), { mode: "create" }).ok).toBe(false);
    expect(buildPayload(values({ issueDate: "2026-02-30" }), { mode: "create" }).ok).toBe(false);
  });
});

describe("loading a saved quote and comparing with the server", () => {
  const saved: QuoteDetailDto = {
    id: "q1",
    quoteNumber: "Q-000001",
    customerId: CUSTOMER,
    customerName: "Acme",
    customerArchived: false,
    opportunityTitle: null,
    opportunityArchived: false,
    opportunityId: null,
    title: "Saved",
    currency: "USD",
    status: "draft",
    issueDate: "2026-11-02",
    validUntil: null,
    taxRateBps: 825,
    discountCents: 500,
    subtotalCents: 8998,
    taxCents: 701,
    totalCents: 9199,
    notes: null,
    version: 2,
    revisesQuoteId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
    items: [
      {
        id: "i1",
        position: 1,
        description: "Widget",
        quantity: 2,
        unitPriceCents: 1999,
        lineTotalCents: 3998,
      },
      {
        id: "i2",
        position: 2,
        description: "Gadget",
        quantity: 1,
        unitPriceCents: 5000,
        lineTotalCents: 5000,
      },
    ],
    revises: null,
    revisions: [],
    statusHistory: [],
  };

  it("round-trips: the form built from a saved quote previews exactly its saved totals", () => {
    const form = toQuoteFormValues(saved);
    expect(form.taxRate).toBe("8.25");
    expect(form.discount).toBe("5.00");
    expect(form.items.map((i) => i.unitPrice)).toEqual(["19.99", "50.00"]);
    const p = quotePreview(form);
    expect(p.ok && compareWithServer(p, saved)).toEqual([]);
  });

  it("reports a mismatch when the server's total differs from the preview", () => {
    const p = quotePreview(toQuoteFormValues(saved));
    expect(compareWithServer(p, { ...saved, taxCents: 702, totalCents: 9200 })).toEqual([
      { field: "tax", preview: 701, saved: 702 },
      { field: "total", preview: 9199, saved: 9200 },
    ]);
  });
});

describe("moveItem", () => {
  it("moves a line to a new position and ignores impossible moves", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(moveItem(["a", "b", "c"], 0, 0)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 3)).toEqual(["a", "b", "c"]);
  });
});
