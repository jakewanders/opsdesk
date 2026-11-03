import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/pdf/document";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";
import { WATERMARK } from "./pdf";

/** GET /api/v1/quotes/:id/pdf over real HTTP (production build, local Supabase) (SIT-247, PRD 8.2, US-08). */
const server = new RealServer();
let owner: Actor, viewer: Actor, other: Actor, outsider: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";
let customerA = "";
let customerB = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
const hdr = (org: string) => ({ "X-Organization-Id": org });
const pdf = (actor: Actor | null, id: string, org = orgA) =>
  server.request(`/api/v1/quotes/${id}/pdf`, actor, { headers: hdr(org) });
const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer());
const post = async (actor: Actor, path: string, json: unknown, org: string) =>
  (
    await (
      await server.request(`/api/v1${path}`, actor, { method: "POST", json, headers: hdr(org) })
    ).json()
  ).data as any;
const makeQuote = (
  actor: Actor,
  org: string,
  customerId: string,
  over: Record<string, unknown> = {},
) =>
  post(
    actor,
    "/quotes",
    {
      customerId,
      title: "PDF quote",
      taxRateBps: 825,
      discountCents: 500,
      notes: "Net 30",
      items: [
        { description: "Widget", quantity: 2, unitPriceCents: 1999 },
        { description: "Gadget", quantity: 1, unitPriceCents: 5000 },
      ],
      ...over,
    },
    org,
  );

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );
const makeCustomer = async (org: string, actor: Actor, name: string) =>
  (
    await (
      await server.request("/api/v1/customers", actor, {
        json: { displayName: name },
        headers: hdr(org),
      })
    ).json()
  ).data.id as string;

beforeAll(async () => {
  await server.start();
  [owner, viewer, other, outsider, guest] = await Promise.all([
    server.member("pdf-owner"),
    server.member("pdf-viewer"),
    server.member("pdf-other"),
    server.member("pdf-outsider"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "PDF Co A");
  orgB = await createOrg(other, "PDF Co B");
  addMember(orgA, viewer, "viewer");
  customerA = await makeCustomer(orgA, owner, "Acme PDF");
  customerB = await makeCustomer(orgB, other, "Globex PDF");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
}, 400_000);

afterAll(() => server.stop());

describe("GET /quotes/:id/pdf", () => {
  it("a draft: 200 application/pdf as an attachment named after the quote, with the stored totals", async () => {
    const q = await makeQuote(owner, orgA, customerA);
    const res = await pdf(owner, q.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${q.quoteNumber}.pdf"`,
    );
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const body = await bytes(res);
    expect(Number(res.headers.get("content-length"))).toBe(body.byteLength);
    expect(Buffer.from(body.slice(0, 5)).toString()).toBe("%PDF-");
    const text = extractPdfText(body).join("\n");
    for (const needle of [
      q.quoteNumber,
      "PDF quote",
      "Draft",
      "Acme PDF",
      "PDF Co A",
      "Widget",
      "Gadget",
      "$19.99",
      "$39.98",
      "$50.00",
      "Subtotal",
      "$89.98",
      "-$5.00",
      "Tax (8.25%)",
      "$7.01",
      "Total",
      "$91.99",
      "Net 30",
    ])
      expect(text, needle).toContain(needle);
    // the numbers are the server's: the same ones the JSON API returns
    expect(q).toMatchObject({ subtotalCents: 8998, taxCents: 701, totalCents: 9199 });
  });

  it("a sent quote: the status on the page is Sent", async () => {
    const q = await makeQuote(owner, orgA, customerA, { title: "Sent PDF quote" });
    await post(owner, `/quotes/${q.id}/transition`, { to: "sent" }, orgA);
    const text = extractPdfText(await bytes(await pdf(owner, q.id))).join("\n");
    expect(text).toContain("Sent PDF quote");
    expect(text).toContain("Sent");
    expect(text).toContain("$91.99");
  });

  it("a real workspace's PDF has no watermark", async () => {
    const q = await makeQuote(owner, orgA, customerA);
    const text = extractPdfText(await bytes(await pdf(owner, q.id))).join("\n");
    expect(text).not.toContain(WATERMARK);
    expect(text).not.toMatch(/fictional/i);
  });

  it("a demo workspace's PDF carries the watermark on every page", async () => {
    const list = await server.request("/api/v1/quotes?limit=5", guest, { headers: hdr(demoOrg) });
    const seeded = (await list.json()).data[0];
    const res = await pdf(guest, seeded.id, demoOrg);
    expect(res.status).toBe(200);
    const pages = extractPdfText(await bytes(res));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).toContain(WATERMARK);
    expect(pages.join("\n")).toContain(seeded.quoteNumber);
  });

  it("a long quote runs onto more pages, each numbered, and the totals come last", async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      description: `Line ${i + 1}`,
      quantity: 1,
      unitPriceCents: 100,
    }));
    const q = await makeQuote(owner, orgA, customerA, {
      title: "Long quote",
      items,
      discountCents: 0,
    });
    const pages = extractPdfText(await bytes(await pdf(owner, q.id)));
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(p).toContain(`Page ${i + 1} of ${pages.length}`));
    expect(pages.at(-1)).toContain(
      `$${(q.totalCents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`,
    );
  });

  it("is deterministic: downloading twice gives the same bytes", async () => {
    const q = await makeQuote(owner, orgA, customerA);
    const a = await bytes(await pdf(owner, q.id));
    const b = await bytes(await pdf(owner, q.id));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("any role may export: a viewer gets the PDF", async () => {
    const q = await makeQuote(owner, orgA, customerA);
    expect((await pdf(viewer, q.id)).status).toBe(200);
  });

  it("another workspace's quote is a 404, whoever asks, and so is an unknown id", async () => {
    const qb = await makeQuote(other, orgB, customerB);
    const unknown = "00000000-0000-4000-8000-000000000999";
    expect((await pdf(owner, qb.id, orgA)).status).toBe(404); // the owner of A, naming A
    expect((await pdf(owner, qb.id, orgB)).status).toBe(404); // named B, not a member
    expect((await pdf(outsider, qb.id, orgB)).status).toBe(404);
    expect((await pdf(owner, unknown, orgA)).status).toBe(404);
    const stranger = await pdf(guest, qb.id, orgB);
    expect(stranger.status).toBe(404);
  });

  it("401 signed out; 400 for a malformed id", async () => {
    const q = await makeQuote(owner, orgA, customerA);
    expect((await pdf(null, q.id)).status).toBe(401);
    expect((await pdf(owner, "not-a-uuid")).status).toBe(400);
  });

  it("hostile text in the quote cannot break the file", async () => {
    const q = await makeQuote(owner, orgA, customerA, {
      title: "Evil ) Tj ET ( injected \\",
      notes: "Pay (net 30) \\ see terms",
    });
    const body = await bytes(await pdf(owner, q.id));
    const text = extractPdfText(body).join("\n");
    expect(text).toContain("Evil ) Tj ET ( injected \\");
    expect(text).toContain("Pay (net 30) \\ see terms");
    expect(Buffer.from(body).toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
