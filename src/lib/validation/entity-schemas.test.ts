import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { createCustomerSchema, updateCustomerSchema } from "@/features/customers/schema";
import { createInvitationSchema } from "@/features/members/schema";
import { createOpportunitySchema, updateOpportunitySchema } from "@/features/opportunities/schema";
import { updateOrganizationSchema } from "@/features/organizations/schema";
import { createQuoteSchema } from "@/features/quotes/schema";
import { createTaskSchema, updateTaskSchema } from "@/features/tasks/schema";

/**
 * [P-06, PRD 11.1] Zod schemas: correct types, trimming, validation errors, Unicode text, invalid URLs, and attempts at script/HTML
 * injection, checked the same way across EVERY entity body schema (not just where a feature test remembered to). A new text field
 * is added to the table below; a schema whose field stops rejecting markup fails here.
 */
const ID = "11111111-1111-4111-8111-111111111111";
const STALE = "2026-11-02T10:00:00.000000+00:00";

type Entry = {
  name: string;
  schema: ZodType;
  /** A body the schema accepts. */
  valid: Record<string, unknown>;
  /** Single-line text fields (name -> how to put a value into the body). */
  lines: Array<{
    path: string;
    put: (body: Record<string, unknown>, v: string) => Record<string, unknown>;
    min?: number;
  }>;
  /** Multi-line text fields. */
  multi: Array<{
    path: string;
    put: (body: Record<string, unknown>, v: string) => Record<string, unknown>;
  }>;
};
const top = (key: string) => (body: Record<string, unknown>, v: string) => ({ ...body, [key]: v });
const inItem = (body: Record<string, unknown>, v: string) => ({
  ...body,
  items: [{ description: v, quantity: 1, unitPriceCents: 100 }],
});

const ENTRIES: Entry[] = [
  {
    name: "create customer",
    schema: createCustomerSchema,
    valid: { displayName: "Acme" },
    lines: [
      { path: "displayName", put: top("displayName") },
      { path: "companyName", put: top("companyName") },
      { path: "phone", put: top("phone") },
    ],
    multi: [{ path: "notes", put: top("notes") }],
  },
  {
    name: "update customer",
    schema: updateCustomerSchema,
    valid: { expectedUpdatedAt: STALE },
    lines: [
      { path: "displayName", put: top("displayName") },
      { path: "companyName", put: top("companyName") },
    ],
    multi: [{ path: "notes", put: top("notes") }],
  },
  {
    name: "create opportunity",
    schema: createOpportunitySchema,
    valid: { customerId: ID, title: "Deal" },
    lines: [{ path: "title", put: top("title") }],
    multi: [{ path: "description", put: top("description") }],
  },
  {
    name: "update opportunity",
    schema: updateOpportunitySchema,
    valid: { expectedUpdatedAt: STALE },
    lines: [{ path: "title", put: top("title") }],
    multi: [{ path: "description", put: top("description") }],
  },
  {
    name: "create task",
    schema: createTaskSchema,
    valid: { title: "Call back" },
    lines: [{ path: "title", put: top("title") }],
    multi: [{ path: "description", put: top("description") }],
  },
  {
    name: "update task",
    schema: updateTaskSchema,
    valid: { expectedUpdatedAt: STALE },
    lines: [{ path: "title", put: top("title") }],
    multi: [{ path: "description", put: top("description") }],
  },
  {
    name: "create quote",
    schema: createQuoteSchema,
    valid: {
      customerId: ID,
      title: "Quote",
      items: [{ description: "Work", quantity: 1, unitPriceCents: 100 }],
    },
    lines: [
      { path: "title", put: top("title") },
      { path: "items.0.description", put: inItem },
    ],
    multi: [{ path: "notes", put: top("notes") }],
  },
  {
    name: "update workspace",
    schema: updateOrganizationSchema,
    valid: { expectedUpdatedAt: STALE },
    lines: [
      { path: "name", put: top("name") },
      { path: "industry", put: top("industry") },
    ],
    multi: [],
  },
];

const issuesOf = (schema: ZodType, body: unknown) => {
  const r = schema.safeParse(body);
  return r.success ? null : r.error.issues.map((i) => i.path.join("."));
};
const parsed = (schema: ZodType, body: unknown) => {
  const r = schema.safeParse(body);
  return r.success ? (r.data as Record<string, unknown>) : null;
};

const MARKUP = [
  "<script>alert(1)</script>",
  "Acme <b>bold</b>",
  "<img src=x onerror=alert(1)>",
  "<!-- comment -->",
  "</div>",
  "<?php echo 1 ?>",
  "<svg/onload=alert(1)>",
];
const CONTROL = ["a\u0000b", "a\u0007b", "a\u001fb", "a\u007fb", "a​b", "a‮b", "a﻿b"];
const UNICODE = [
  "Zoë Müller",
  "山田太郎",
  "Ольга Иванова",
  "مرحبا بالعالم",
  "🙂 Smile Co",
  "Crème brûlée & Fils",
  "o'connor, jr.",
];

for (const entry of ENTRIES) {
  describe(`${entry.name} [P-06 / PRD 11.1]`, () => {
    it("the base body is valid (so every failure below is the field under test)", () => {
      expect(issuesOf(entry.schema, entry.valid)).toBeNull();
    });

    it("is strict: an unknown field, an organization id and a created-by id are refused, not dropped", () => {
      for (const extra of [
        "organizationId",
        "createdBy",
        "id",
        "completedAt",
        "kind",
        "totalCents",
        "role",
      ])
        expect(issuesOf(entry.schema, { ...entry.valid, [extra]: "x" }), extra).not.toBeNull();
    });

    it("refuses non-object bodies", () => {
      for (const body of [null, undefined, "text", 42, [], true])
        expect(issuesOf(entry.schema, body)).not.toBeNull();
    });

    for (const field of [...entry.lines, ...entry.multi]) {
      const kind = entry.lines.includes(field as never) ? "single-line" : "multi-line";
      describe(`${field.path} (${kind})`, () => {
        it("keeps Unicode text exactly (accents, CJK, Cyrillic, Arabic, emoji, apostrophes, ampersands)", () => {
          for (const text of UNICODE) {
            const out = parsed(entry.schema, field.put(entry.valid, text));
            expect(out, text).not.toBeNull();
            const value = field.path.includes(".")
              ? (out!.items as Array<{ description: string }>)[0].description
              : (out![field.path] as string);
            expect(value.normalize("NFC")).toBe(text.normalize("NFC"));
          }
        });

        it("trims surrounding whitespace and nothing inside", () => {
          const out = parsed(entry.schema, field.put(entry.valid, "   Ana  María   "));
          const value = field.path.includes(".")
            ? (out!.items as Array<{ description: string }>)[0].description
            : (out![field.path] as string);
          expect(value).toBe("Ana  María");
        });

        it("refuses script and HTML injection with an error on THIS field", () => {
          for (const markup of MARKUP) {
            const issues = issuesOf(entry.schema, field.put(entry.valid, markup));
            expect(issues, markup).not.toBeNull();
            expect(
              issues!.some((p) => p === field.path),
              `${markup} -> ${issues}`,
            ).toBe(true);
          }
        });

        it("allows a bare less-than or ampersand that is not markup", () => {
          expect(issuesOf(entry.schema, field.put(entry.valid, "5 < 6 & 7 > 3"))).toBeNull();
        });

        it("refuses control, zero-width and bidirectional-override characters", () => {
          for (const text of CONTROL)
            expect(
              issuesOf(entry.schema, field.put(entry.valid, text)),
              JSON.stringify(text),
            ).not.toBeNull();
        });

        it("refuses numbers, objects and arrays where text belongs", () => {
          for (const bad of [42, { a: 1 }, ["x"], true])
            expect(issuesOf(entry.schema, field.put(entry.valid, bad as never))).not.toBeNull();
        });

        if (kind === "single-line")
          it("refuses a line break", () => {
            for (const text of ["a\nb", "a\rb", "a b"])
              expect(
                issuesOf(entry.schema, field.put(entry.valid, text)),
                JSON.stringify(text),
              ).not.toBeNull();
          });
        else
          it("allows line breaks and tabs", () => {
            expect(
              issuesOf(entry.schema, field.put(entry.valid, "line one\nline two\n\tindented")),
            ).toBeNull();
          });
      });
    }
  });
}

describe("URLs and e-mail addresses [P-06 / PRD 11.1]", () => {
  const website = (v: unknown) =>
    createCustomerSchema.safeParse({ displayName: "Acme", website: v });
  it("a website must be http or https with a host", () => {
    for (const ok of [
      "https://example.com",
      "http://example.com/path?x=1",
      "https://sub.example.co.uk",
    ])
      expect(website(ok).success, ok).toBe(true);
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "ftp://example.com",
      "//example.com",
      "example",
      "http://",
      "https://exa mple.com",
      "vbscript:x",
      " javascript:alert(1)",
    ])
      expect(website(bad).success, bad).toBe(false);
  });
  it("a website over 255 characters is refused", () => {
    expect(website(`https://example.com/${"p".repeat(256)}`).success).toBe(false);
  });
  const email = (v: unknown) => createCustomerSchema.safeParse({ displayName: "Acme", email: v });
  it("an e-mail is normalized and must look like an address", () => {
    expect(email("  Ada@Example.COM ").success).toBe(true);
    for (const bad of [
      "not-an-email",
      "a@",
      "@b.co",
      "a b@c.co",
      "a@b",
      "a@@b.co",
      "<a@b.co>",
      "a@b.co, c@d.co",
    ])
      expect(email(bad).success, bad).toBe(false);
  });
  it("an invitation e-mail follows the same rule", () => {
    expect(
      createInvitationSchema.safeParse({ email: "Ada@Example.com", role: "member" }).success,
    ).toBe(true);
    expect(
      createInvitationSchema.safeParse({ email: "javascript:alert(1)", role: "member" }).success,
    ).toBe(false);
    expect(
      createInvitationSchema.safeParse({ email: "a@b.co", role: "owner" }).success,
      "owner is never invitable",
    ).toBe(false);
  });
});

describe("types and ids [P-06 / PRD 11.1]", () => {
  it("ids must be UUIDs", () => {
    for (const bad of ["1", "not-a-uuid", "11111111-1111-4111-8111-11111111111", 5, null])
      expect(
        createOpportunitySchema.safeParse({ customerId: bad, title: "Deal" }).success,
        String(bad),
      ).toBe(false);
  });
  it("money is whole cents: floats, strings and negatives are refused", () => {
    for (const bad of [10.5, "100", -1, Number.NaN, Number.POSITIVE_INFINITY, 1e21])
      expect(
        createOpportunitySchema.safeParse({ customerId: ID, title: "Deal", amountCents: bad })
          .success,
        String(bad),
      ).toBe(false);
    expect(
      createOpportunitySchema.safeParse({ customerId: ID, title: "Deal", amountCents: 0 }).success,
    ).toBe(true);
  });
  it("dates are real calendar days written YYYY-MM-DD", () => {
    for (const bad of [
      "2026-02-30",
      "2026-13-01",
      "26-01-01",
      "2026/01/01",
      "2026-1-1",
      "tomorrow",
      20260101,
      "2026-01-01T00:00:00Z",
    ])
      expect(
        createTaskSchema.safeParse({ title: "Call back", dueDate: bad }).success,
        String(bad),
      ).toBe(false);
    expect(createTaskSchema.safeParse({ title: "Call back", dueDate: "2028-02-29" }).success).toBe(
      true,
    );
  });
  it("a version token must be the timestamp the server sent", () => {
    for (const bad of ["yesterday", "2026-11-02", "", 5, null])
      expect(updateTaskSchema.safeParse({ expectedUpdatedAt: bad }).success, String(bad)).toBe(
        false,
      );
  });
  it("enums accept their values only, in the exact case", () => {
    expect(createTaskSchema.safeParse({ title: "Call back", status: "todo" }).success).toBe(true);
    for (const bad of ["TODO", "Todo", "done ", "finished", 1, null])
      expect(
        createTaskSchema.safeParse({ title: "Call back", status: bad }).success,
        String(bad),
      ).toBe(false);
  });
  it("lengths count characters, not UTF-16 units: 150 emoji pass as a title, 151 do not", () => {
    expect(
      createOpportunitySchema.safeParse({ customerId: ID, title: "🙂".repeat(150) }).success,
    ).toBe(true);
    expect(
      createOpportunitySchema.safeParse({ customerId: ID, title: "🙂".repeat(151) }).success,
    ).toBe(false);
    expect(
      createOpportunitySchema.safeParse({ customerId: ID, title: "a" }).success,
      "too short",
    ).toBe(false);
    expect(
      createOpportunitySchema.safeParse({ customerId: ID, title: "   " }).success,
      "blank",
    ).toBe(false);
  });
  it("every error is a readable sentence with a path, never an empty or internal message", () => {
    const r = createCustomerSchema.safeParse({
      displayName: "",
      email: "x",
      website: "javascript:1",
      tags: "vip",
    });
    expect(r.success).toBe(false);
    if (!r.success)
      for (const issue of r.error.issues) {
        expect(issue.message.length).toBeGreaterThan(5);
        expect(issue.message).not.toMatch(/undefined|\[object|Invalid input: expected/i);
      }
  });
});
