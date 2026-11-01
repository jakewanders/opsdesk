import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ValidationError } from "@/lib/api/errors";
import {
  cents,
  choice,
  codePointLength,
  DEFAULT_LIMIT,
  email,
  isoDate,
  listQuery,
  MAX_CENTS,
  MAX_LIMIT,
  multiLine,
  optionalSingleLine,
  paginate,
  parseBody,
  parseQuery,
  singleLine,
  tags,
  url,
  uuid,
} from "./index";

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value);
const bad = (schema: z.ZodType, value: unknown) => {
  const r = schema.safeParse(value);
  expect(r.success, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};
const fieldErrorsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).fieldErrors;
  }
  throw new Error("expected a ValidationError");
};

describe("singleLine", () => {
  const name = singleLine(80, 2);
  it("trims and normalizes to NFC", () => {
    expect(name.parse("  Acme Co  ")).toBe("Acme Co");
    // "e" + combining acute becomes the single precomposed code point
    expect(name.parse("Café")).toBe("Café");
  });
  it("accepts Unicode text from several scripts", () => {
    for (const v of [
      "José Núñez",
      "山田 太郎",
      "Müller & Söhne",
      "Ольга Иванова",
      "مكتب الخدمات",
      "Dr. Zoë 🌿",
    ]) {
      expect(ok(name, v).success, v).toBe(true);
    }
  });
  it("counts code points like Postgres, so an emoji is one character", () => {
    expect(codePointLength("🌿🌿🌿")).toBe(3);
    expect(ok(singleLine(3), "🌿🌿🌿").success).toBe(true);
    expect(ok(singleLine(3), "🌿🌿🌿🌿").success).toBe(false);
    expect(ok(singleLine(80), "😀".repeat(80)).success).toBe(true);
  });
  it("enforces min and max after trimming", () => {
    expect(bad(name, " a ")[0]).toMatch(/between 2 and 80/);
    expect(bad(name, "x".repeat(81))[0]).toMatch(/between 2 and 80/);
    expect(ok(name, "x".repeat(80)).success).toBe(true);
    expect(bad(singleLine(10), "   ")[0]).toBe("Enter a value.");
  });
  it("rejects non-strings", () => {
    for (const v of [undefined, null, 5, {}, ["a"]]) bad(name, v);
  });
  it("rejects control characters, line breaks, and invisible overrides in single-line fields", () => {
    for (const v of [
      "a\u0000b",
      "a\u0007b",
      "a\u001bb",
      "a\u007fb",
      "a\nb",
      "a\rb",
      "a\u2028b",
      "a\u0085b",
      "a\u202eb",
      "a\u200bb",
      "a\u2066b",
      "a" + String.fromCharCode(0xfeff) + "b",
    ]) {
      expect(ok(name, v).success, JSON.stringify(v)).toBe(false);
    }
  });
  it("keeps emoji joiners working (ZWJ and variation selectors are allowed)", () => {
    expect(ok(name, "👩‍💻 Dev").success).toBe(true);
    expect(ok(name, "❤️ Care").success).toBe(true);
  });
  it("rejects script and HTML injection attempts", () => {
    for (const v of [
      "<script>alert(1)</script>",
      "Bob <img src=x onerror=alert(1)>",
      "<!-- hidden -->",
      "<?php echo 1; ?>",
      "<!DOCTYPE html>",
      "</div>",
      "a<b>bold</b>",
      "<svg/onload=alert(1)>",
    ]) {
      expect(bad(name, v)[0], v).toMatch(/HTML/);
    }
  });
  it("allows plain text that merely contains angle brackets and ampersands", () => {
    for (const v of [
      "Revenue < Costs",
      "5 < 10 > 3",
      "R&D budget",
      "a <= b",
      "x <3 y",
      "Tom & Jerry's",
    ]) {
      expect(ok(name, v).success, v).toBe(true);
    }
  });
  it("does not execute or rewrite entities or javascript: text; it is stored as typed", () => {
    expect(name.parse("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(name.parse("&lt;b&gt;")).toBe("&lt;b&gt;");
  });
});

describe("multiLine and optional text", () => {
  it("allows line breaks, normalizes CRLF, still rejects controls and tags", () => {
    expect(multiLine(100).parse("line one\r\nline two\rthree")).toBe("line one\nline two\nthree");
    expect(ok(multiLine(100), "tab\there").success).toBe(true);
    expect(ok(multiLine(100), "a\u0000b").success).toBe(false);
    expect(ok(multiLine(100), "ok\n<script>x</script>").success).toBe(false);
  });
  it("caps length in code points", () => {
    expect(ok(multiLine(5), "12345").success).toBe(true);
    expect(ok(multiLine(5), "123456").success).toBe(false);
  });
  it("optional fields turn blank and missing into null", () => {
    const f = optionalSingleLine(20);
    expect(f.parse("")).toBeNull();
    expect(f.parse("   ")).toBeNull();
    expect(f.parse(null)).toBeNull();
    expect(f.parse(undefined)).toBeNull();
    expect(f.parse(" ok ")).toBe("ok");
    expect(ok(f, "x".repeat(21)).success).toBe(false);
  });
});

describe("uuid", () => {
  it("accepts canonical ids and lowercases them", () => {
    expect(uuid().parse("A1B2C3D4-0000-4000-8000-000000000001")).toBe(
      "a1b2c3d4-0000-4000-8000-000000000001",
    );
  });
  it("rejects anything else", () => {
    for (const v of [
      "",
      "abc",
      "a1b2c3d4000040008000000000000001",
      "a1b2c3d4-0000-4000-8000-00000000000g",
      "a1b2c3d4-0000-4000-8000-0000000000012",
      "1; drop table x",
      12,
      null,
    ]) {
      bad(uuid(), v);
    }
  });
});

describe("isoDate", () => {
  it("accepts real calendar dates, including leap days", () => {
    for (const v of ["2026-11-01", "2028-02-29", "1999-12-31"])
      expect(ok(isoDate(), v).success).toBe(true);
  });
  it("rejects malformed and impossible dates", () => {
    for (const v of [
      "2026-02-30",
      "2027-02-29",
      "2026-13-01",
      "2026-00-10",
      "2026-1-1",
      "11/01/2026",
      "2026-11-01T00:00:00Z",
      "",
      " 2026-11-01",
      20261101,
    ]) {
      bad(isoDate(), v);
    }
  });
});

describe("cents", () => {
  it("accepts whole non-negative amounts up to the limit", () => {
    for (const v of [0, 1, 12345, MAX_CENTS]) expect(ok(cents(), v).success).toBe(true);
  });
  it("rejects negatives, fractions, NaN, strings, and over-limit values", () => {
    for (const v of [-1, 1.5, 0.1 + 0.2, Number.NaN, Infinity, "100", null, MAX_CENTS + 1])
      bad(cents(), v);
  });
  it("accepts a custom upper bound", () => {
    expect(ok(cents(500), 500).success).toBe(true);
    expect(bad(cents(500), 501)[0]).toMatch(/too large/);
  });
});

describe("email", () => {
  it("trims and lowercases", () => {
    expect(email().parse("  Jane.Doe+Work@Example.COM ")).toBe("jane.doe+work@example.com");
  });
  it("rejects malformed addresses, whitespace inside, and oversize values", () => {
    for (const v of [
      "",
      "plain",
      "a@",
      "@b.com",
      "a b@c.com",
      "a@b",
      "a@@b.com",
      "<a@b.com>",
      `${"x".repeat(250)}@b.com`,
    ]) {
      bad(email(), v);
    }
  });
});

describe("url", () => {
  const web = url();
  it("accepts http and https URLs", () => {
    for (const v of [
      "https://example.com",
      "http://example.com/path?q=1#x",
      "https://sub.example.co.uk:8443/a",
      "https://münchen.example",
    ]) {
      expect(ok(web, v).success, v).toBe(true);
    }
  });
  it("rejects dangerous or non-web schemes", () => {
    for (const v of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "ftp://example.com",
      "vbscript:x",
      "mailto:a@b.com",
      "//example.com",
    ]) {
      bad(web, v);
    }
  });
  it("rejects invalid URLs, embedded credentials, whitespace, and oversize values", () => {
    for (const v of [
      "not a url",
      "https://",
      "http:// example.com",
      "https://user:pass@example.com",
      "https://user@example.com",
      " https://example.com/a b",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      bad(web, v);
    }
  });
  it("honours a custom scheme list", () => {
    expect(ok(url(["https"]), "http://example.com").success).toBe(false);
    expect(ok(url(["https"]), "https://example.com").success).toBe(true);
  });
});

describe("tags", () => {
  it("accepts 0 to 10 tags of 1 to 30 characters", () => {
    expect(tags().parse([])).toEqual([]);
    expect(tags().parse(["  vip ", "Q4"])).toEqual(["vip", "Q4"]);
    expect(
      ok(
        tags(),
        Array.from({ length: 10 }, (_, i) => `t${i}`),
      ).success,
    ).toBe(true);
    expect(ok(tags(), ["x".repeat(30)]).success).toBe(true);
  });
  it("rejects more than 10, over-long, empty, tag-like, and non-array input", () => {
    bad(
      tags(),
      Array.from({ length: 11 }, (_, i) => `t${i}`),
    );
    bad(tags(), ["x".repeat(31)]);
    bad(tags(), [""]);
    bad(tags(), ["<b>x</b>"]);
    bad(tags(), "vip");
    bad(tags(), [5]);
  });
  it("collapses duplicates ignoring case, keeping the first spelling", () => {
    expect(tags().parse(["VIP", "vip", "Vip", "other"])).toEqual(["VIP", "other"]);
  });
  it("reports the index of the offending tag", () => {
    const r = tags().safeParse(["ok", "<b>"]);
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues[0].path).toEqual([1]);
  });
});

describe("choice", () => {
  it("accepts listed values and says what is allowed otherwise", () => {
    const stage = choice(["lead", "won"] as const);
    expect(stage.parse("won")).toBe("won");
    expect(bad(stage, "WON")[0]).toBe("Choose one of: lead, won.");
  });
});

describe("listQuery and parseQuery", () => {
  const schema = listQuery({
    sortable: ["name", "created_at"] as const,
    defaultSort: "created_at",
    filters: { q: singleLine(100).optional(), archived: z.enum(["true", "false"]).optional() },
  });

  it("applies defaults: page 1, limit 25, default sort, desc", () => {
    expect(DEFAULT_LIMIT).toBe(25);
    expect(parseQuery(schema, "")).toEqual({
      page: 1,
      limit: 25,
      sort: "created_at",
      order: "desc",
    });
  });
  it("parses page, limit, sort, order, and filters", () => {
    expect(parseQuery(schema, "page=3&limit=50&sort=name&order=asc&q=acme&archived=true")).toEqual({
      page: 3,
      limit: 50,
      sort: "name",
      order: "asc",
      q: "acme",
      archived: "true",
    });
  });
  it("treats empty values as absent", () => {
    expect(parseQuery(schema, "q=&page=&sort=")).toEqual({
      page: 1,
      limit: 25,
      sort: "created_at",
      order: "desc",
    });
  });
  it("accepts URLSearchParams too", () => {
    expect(parseQuery(schema, new URLSearchParams({ limit: "10" })).limit).toBe(10);
  });
  it("rejects unknown sort fields with a 422 naming the allowed ones, never passing them on", () => {
    for (const sort of [
      "password",
      "name;drop table customers",
      "name desc",
      "NAME",
      "created_at,name",
      "1",
      "__proto__",
      "constructor",
    ]) {
      const errors = fieldErrorsOf(() => parseQuery(schema, new URLSearchParams({ sort })));
      expect(errors?.sort?.[0], sort).toBe("Sort by one of: name, created_at.");
    }
  });
  it("rejects a bad order", () => {
    expect(fieldErrorsOf(() => parseQuery(schema, "order=up"))?.order).toBeTruthy();
  });
  it("REJECTS limit above 100 (documented: never clamped)", () => {
    expect(MAX_LIMIT).toBe(100);
    expect(parseQuery(schema, "limit=100").limit).toBe(100);
    expect(fieldErrorsOf(() => parseQuery(schema, "limit=101"))?.limit?.[0]).toBe(
      "limit must be 100 or less.",
    );
    expect(fieldErrorsOf(() => parseQuery(schema, "limit=100000"))?.limit).toBeTruthy();
  });
  it("rejects page and limit that are zero, negative, fractional, or not numbers", () => {
    for (const q of [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=abc",
      "page=1e3",
      "page=0x10",
      "limit=0",
      "limit=-5",
      "limit=2.5",
      "limit=ten",
      "page=99999999999",
    ]) {
      const errors = fieldErrorsOf(() => parseQuery(schema, q));
      expect(Object.keys(errors ?? {}).length, q).toBeGreaterThan(0);
    }
  });
  it("rejects unknown parameters and repeated scalar parameters", () => {
    expect(fieldErrorsOf(() => parseQuery(schema, "stage=lead"))).toBeTruthy();
    expect(fieldErrorsOf(() => parseQuery(schema, "page=1&page=2"))?.page).toBeTruthy();
  });
  it("validates filters with their own schemas", () => {
    expect(fieldErrorsOf(() => parseQuery(schema, "archived=maybe"))?.archived).toBeTruthy();
    expect(
      fieldErrorsOf(() => parseQuery(schema, `q=${encodeURIComponent("<script>")}`))?.q?.[0],
    ).toMatch(/HTML/);
  });
  it("collects every error at once", () => {
    const errors = fieldErrorsOf(() => parseQuery(schema, "page=0&limit=500&sort=x"));
    expect(Object.keys(errors ?? {}).sort()).toEqual(["limit", "page", "sort"]);
  });
  it("honours defaultOrder", () => {
    const s = listQuery({ sortable: ["name"] as const, defaultSort: "name", defaultOrder: "asc" });
    expect(parseQuery(s, "").order).toBe("asc");
  });
});

describe("parseBody", () => {
  const schema = z.strictObject({ name: singleLine(80, 2), tags: tags().default([]) });
  const req = (body: string) =>
    new Request("http://localhost/api/v1/x", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });

  it("returns the parsed, normalized body", async () => {
    expect(await parseBody(schema, req('{"name":"  Acme  ","tags":["a","A"]}'))).toEqual({
      name: "Acme",
      tags: ["a"],
    });
  });
  it("turns schema failures into a 422 with fieldErrors keyed by path", async () => {
    const error = await parseBody(schema, req('{"name":"x","tags":["ok","<b>"]}')).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.status).toBe(422);
    expect(error.fieldErrors).toMatchObject({
      name: [expect.any(String)],
      "tags.1": [expect.stringMatching(/HTML/)],
    });
  });
  it("rejects unknown fields on a strict schema", async () => {
    const error = await parseBody(schema, req('{"name":"Acme","organization_id":"x"}')).catch(
      (e) => e,
    );
    expect(error.status).toBe(422);
    expect(Object.keys(error.fieldErrors)).toContain("_form");
  });
  it("leaves malformed JSON as a 400 and a non-object body as a 422", async () => {
    const malformed = await parseBody(schema, req("{nope")).catch((e) => e);
    expect(malformed.status).toBe(400);
    const array = await parseBody(schema, req("[1,2]")).catch((e) => e);
    expect(array.status).toBe(422);
  });
});

describe("paginate", () => {
  it("computes offset, range and meta", () => {
    expect(paginate({ page: 3, limit: 25 }, 130)).toEqual({
      offset: 50,
      from: 50,
      to: 74,
      meta: { page: 3, limit: 25, total: 130, totalPages: 6 },
    });
  });
  it("handles empty collections, exact multiples, and pages past the end", () => {
    expect(paginate({ page: 1, limit: 25 }, 0).meta).toEqual({
      page: 1,
      limit: 25,
      total: 0,
      totalPages: 0,
    });
    expect(paginate({ page: 1, limit: 25 }, 50).meta.totalPages).toBe(2);
    expect(paginate({ page: 9, limit: 25 }, 10).meta).toMatchObject({ page: 9, totalPages: 1 });
  });
  it("treats a negative or fractional total as safe", () => {
    expect(paginate({ page: 1, limit: 10 }, -4).meta.total).toBe(0);
    expect(paginate({ page: 1, limit: 10 }, 10.9).meta.total).toBe(10);
  });
});
