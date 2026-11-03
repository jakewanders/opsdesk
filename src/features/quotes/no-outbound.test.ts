import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/lib/api/org-context";

/**
 * "Send" never emails (PRD 8.2, US-08; SIT-267): in a demo, and everywhere in v1, sending a quote only changes its status. Three
 * guards: the service makes no outbound request when it sends, the server code of the quote feature contains no way to make one,
 * and neither do the quote functions in the database.
 */
vi.mock("./repository", () => ({
  findQuote: vi.fn(async () => ({
    id: "q1",
    quote_number: "Q-000001",
    customer_id: "c1",
    opportunity_id: null,
    title: "T",
    currency: "USD",
    status: "sent",
    issue_date: "2026-11-01",
    valid_until: null,
    tax_rate_bps: 0,
    discount_cents: 0,
    subtotal_cents: 100,
    tax_cents: 0,
    total_cents: 100,
    notes: null,
    version: 2,
    revises_quote_id: null,
    created_by: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    archived_at: null,
    customer: { display_name: "C" },
  })),
  findItems: vi.fn(async () => []),
  findRevisions: vi.fn(async () => []),
  findRevised: vi.fn(async () => null),
  findStatusHistory: vi.fn(async () => []),
  rpcTransition: vi.fn(async () => ({})),
}));

const demoCtx = {
  user: { id: "u1", isAnonymous: true },
  org: { id: "o1", name: "Demo", kind: "demo", expiresAt: "2099-01-01T00:00:00Z", timezone: "UTC" },
  role: "owner",
  kind: "demo",
  expired: false,
} as unknown as OrgContext;

afterEach(() => vi.restoreAllMocks());

describe("sending a quote makes no outbound call", () => {
  it("the service sends in a demo without a single fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { transitionForOrg } = await import("./service");
    const { rpcTransition } = await import("./repository");
    const result = await transitionForOrg({} as never, demoCtx, "q1", { to: "sent" });
    expect(result.status).toBe("sent");
    expect(rpcTransition).toHaveBeenCalledWith(expect.anything(), "q1", 2, "sent");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const OUTBOUND =
  /\bfetch\(|XMLHttpRequest|nodemailer|sendgrid|mailgun|postmark|\bresend\b|\bsmtp\b|mailto:|\bwebhook|net\.http|http_post|http_get|pg_net|dblink/i;

describe("the quote code has no way to call out", () => {
  const serverFiles = [
    ...walk("src/features/quotes").filter(
      (f) =>
        /\.(ts)$/.test(f) && !/\.test\.|\.integration\./.test(f) && !f.includes("/components/"),
    ),
    ...walk("src/app/api/v1/quotes").filter((f) => f.endsWith(".ts")),
    "src/lib/pdf/document.ts",
  ];
  it("lists the files it checked", () => {
    expect(serverFiles.length).toBeGreaterThan(6);
  });
  it.each(serverFiles)("%s", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(OUTBOUND);
  });
  it.each(["20261101003600_quotes.sql", "20261101003800_quote_functions.sql"])(
    "migration %s",
    (file) => {
      const sql = readFileSync(join("supabase/migrations", file), "utf8");
      expect(sql).not.toMatch(OUTBOUND);
    },
  );
  it("the interface has no 'email' or 'notify' option on send", () => {
    const actions = readFileSync("src/features/quotes/components/quote-actions.tsx", "utf8");
    expect(actions).not.toMatch(/sendEmail|notifyCustomer|email:\s*true/i);
    expect(actions).toMatch(/nothing is emailed/);
  });
});
