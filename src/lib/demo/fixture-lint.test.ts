import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintFixtureText } from "./fixture-lint";
import { DEMO_SEED_MANIFEST } from "./seed-manifest";

describe("lintFixtureText", () => {
  it("accepts example.com addresses and 555-01xx phones in any common format", () => {
    for (const ok of [
      "ada.aldermoor@example.com",
      "(202) 555-0142",
      "+1 202 555-0100",
      "202-555-0199",
      "555-0123",
      "Call 202.555.0107 today",
    ]) {
      expect(lintFixtureText(ok), ok).toEqual([]);
    }
  });
  it("rejects real-looking emails", () => {
    for (const bad of [
      "jane@gmail.com",
      "bob@acme.co",
      "x@example.org",
      "sales@company.io",
      "a@sub.example.com",
    ]) {
      expect(lintFixtureText(bad).length, bad).toBeGreaterThan(0);
    }
  });
  it("rejects phones outside the reserved fictional block", () => {
    for (const bad of [
      "(804) 555-0200",
      "804-555-1234",
      "(202) 556-0142",
      "+1 415 867 5309",
      "(202) 555-0200",
      "202.555.0200",
    ]) {
      expect(lintFixtureText(bad).length, bad).toBeGreaterThan(0);
    }
  });
  it("rejects well-known real brands", () => {
    expect(lintFixtureText("Acme and Amazon Logistics")).toEqual(["real brand name: Amazon"]);
  });
  it("does not trip on ids, dates or ordinary numbers", () => {
    expect(
      lintFixtureText(
        "seed version 3 on 2026-11-01 at 09:00, 1000 rows, id 91000000-0000-0000-0000-000000000001",
      ),
    ).toEqual([]);
  });
});

/** Seed files: any migration that defines or registers demo fixtures or seeders, plus supabase/seed.sql. */
function seedFiles(): string[] {
  const dir = "supabase/migrations";
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(dir, f))
    .filter((f) =>
      /demo_seed|seed_demo|register_demo_seeder|private\.demo_(company|person|email|phone)/.test(
        readFileSync(f, "utf8"),
      ),
    );
  return [...migrations, "supabase/seed.sql", "src/lib/demo/seed-manifest.ts"];
}

describe("demo seed files obey the fiction rules", () => {
  const files = seedFiles();
  it("finds the seed registry migration", () => {
    expect(files.some((f) => f.includes("demo_seed_registry"))).toBe(true);
  });
  for (const file of files) {
    it(`${file} has no real-looking email, phone or brand`, () => {
      expect(lintFixtureText(readFileSync(file, "utf8"))).toEqual([]);
    });
  }
});

describe("seed manifest", () => {
  it("states the PRD targets", () => {
    expect(DEMO_SEED_MANIFEST).toMatchObject({
      customers: 18,
      opportunities: 10,
      tasks: 24,
      quotes: 4,
      activityEvents: 40,
      historyDays: 90,
    });
  });
});
