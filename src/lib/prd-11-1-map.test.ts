import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * [P-06, PRD 11.1] Every bullet of the unit-test list maps to named tests, and this test fails when a mapped file or test name
 * disappears (so the map in docs/TEST_MAP.md cannot rot). The coverage numbers recorded in docs/PROGRESS.md come from
 * `npm run test:coverage`; this file is about presence, not percentage.
 */
type Ref = { file: string; test: string };
const MAP: Record<string, Ref[]> = {
  "Quote totals: 0%, fractional-bps rates, large amounts, discounts, rounding half-up, rejected negative/overflow cases":
    [
      {
        file: "src/lib/domain/quotes.test.ts",
        test: "0% tax: total is the subtotal minus the discount",
      },
      { file: "src/lib/domain/quotes.test.ts", test: "very small rates: 1 bp (0.01%)" },
      { file: "src/lib/domain/quotes.test.ts", test: "large amounts stay exact" },
      {
        file: "src/lib/domain/quotes.test.ts",
        test: "a discount equal to the subtotal leaves nothing taxable",
      },
      { file: "src/lib/domain/quotes.test.ts", test: "rounds half up, never half down" },
      { file: "src/lib/domain/quotes.test.ts", test: "negative and fractional discounts" },
      {
        file: "src/lib/domain/quotes.test.ts",
        test: "overflow: a total beyond the safe integer range is refused",
      },
      {
        file: "src/lib/domain/quote-functions.integration.test.ts",
        test: "totals: the database equals the TypeScript module",
      },
    ],
  "Pipeline aggregate: open stages only, weighted calculation, won/lost behavior": [
    {
      file: "src/lib/domain/pipeline.test.ts",
      test: "pipelineTotal and weightedPipeline count OPEN stages only",
    },
    {
      file: "src/lib/domain/pipeline.test.ts",
      test: "weightedAmountCents: round half up, per row",
    },
    { file: "src/lib/domain/pipeline.test.ts", test: "won sets closedAt, probability 100" },
    { file: "src/lib/domain/pipeline.test.ts", test: "lost requires a reason" },
    {
      file: "src/features/dashboard/dashboard.integration.test.ts",
      test: "SQL and TypeScript agree",
    },
  ],
  "Task overdue/date boundaries by timezone and daylight-saving transitions": [
    {
      file: "src/lib/domain/tasks.test.ts",
      test: "New York spring forward (2026-03-08, a 23-hour day)",
    },
    {
      file: "src/lib/domain/tasks.test.ts",
      test: "New York fall back (2026-11-01, a 25-hour day)",
    },
    {
      file: "src/lib/domain/tasks.test.ts",
      test: "flips exactly at local midnight, in three zones",
    },
    { file: "src/lib/domain/tasks.test.ts", test: "due today is not overdue" },
    {
      file: "src/lib/domain/tasks.test.ts",
      test: "due soon: today through today + 7, both included",
    },
    { file: "src/lib/domain/day-range.test.ts", test: "" },
    {
      file: "src/lib/domain/reports.test.ts",
      test: "a 23-hour spring-forward day is still one bucket",
    },
  ],
  "Zod schemas: types, trimming, validation errors, Unicode text, invalid URLs, script/HTML injection":
    [
      { file: "src/lib/validation/validation.test.ts", test: "isoDate" },
      {
        file: "src/lib/validation/entity-schemas.test.ts",
        test: "refuses script and HTML injection with an error on THIS field",
      },
      { file: "src/lib/validation/entity-schemas.test.ts", test: "keeps Unicode text exactly" },
      {
        file: "src/lib/validation/entity-schemas.test.ts",
        test: "a website must be http or https with a host",
      },
      {
        file: "src/lib/validation/entity-schemas.test.ts",
        test: "trims surrounding whitespace and nothing inside",
      },
      {
        file: "src/lib/validation/entity-schemas.test.ts",
        test: "lengths count characters, not UTF-16 units",
      },
      { file: "src/features/customers/customers.test.ts", test: "" },
    ],
  "Permission table and organization-scoping helper logic": [
    { file: "src/lib/permissions/can.test.ts", test: "" },
    { file: "src/lib/permissions/endpoints.test.ts", test: "" },
    { file: "src/lib/api/org-context.test.ts", test: "" },
    {
      file: "src/lib/permissions/endpoint-matrix.integration.test.ts",
      test: "endpoint x caller matrix",
    },
  ],
  "Demo expiry/quota/reset rules": [
    {
      file: "src/lib/demo/time-remaining.test.ts",
      test: "never shows a negative or fractional time",
    },
    {
      file: "src/lib/demo/restart.test.ts",
      test: "explains capacity, non-guests and anything else without leaking internals",
    },
    {
      file: "src/lib/demo/demo-caps.integration.test.ts",
      test: "a guest hits the cap and the error maps to a 429 envelope",
    },
    { file: "src/lib/demo/reset-endpoint.integration.test.ts", test: "DEMO_RESET_THROTTLED" },
    {
      file: "src/lib/demo/demo-entry.integration.test.ts",
      test: "five simultaneous calls from one guest create exactly one workspace",
    },
    { file: "supabase/tests/demo-expiry.test.sql", test: "" },
    { file: "supabase/tests/demo-caps.test.sql", test: "" },
    { file: "supabase/tests/reset-demo.test.sql", test: "" },
    { file: "src/lib/cleanup/guard.test.ts", test: "evaluateCleanupTarget" },
  ],
  "CSV sanitization and import validation": [
    { file: "src/lib/csv/write.test.ts", test: "escapeCsvCell: formula injection" },
    { file: "src/lib/csv/parse.test.ts", test: "drops a leading byte-order mark" },
    {
      file: "src/features/customers/import/analyze.test.ts",
      test: "reports the exact row, field and code of every problem",
    },
    { file: "src/features/customers/import/analyze.test.ts", test: "per-field length rules" },
    { file: "src/features/customers/import/upload.test.ts", test: "refuses %s as not UTF-8" },
  ],
};

describe("PRD 11.1 unit-test list is mapped to named tests [P-06]", () => {
  it("lists the seven bullets of the PRD", () => {
    expect(Object.keys(MAP)).toHaveLength(7);
  });
  for (const [bullet, refs] of Object.entries(MAP))
    it(bullet, () => {
      expect(refs.length).toBeGreaterThan(0);
      for (const { file, test } of refs) {
        expect(existsSync(file), `${file} exists`).toBe(true);
        if (test) expect(readFileSync(file, "utf8"), `${file} has "${test}"`).toContain(test);
      }
    });
});
