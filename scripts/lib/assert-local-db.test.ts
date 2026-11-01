import { describe, expect, it } from "vitest";
import { localDbViolations } from "./assert-local-db.mjs";

describe("localDbViolations", () => {
  it("allows an empty environment", () => {
    expect(localDbViolations({}, [])).toEqual([]);
  });

  it("allows local URLs", () => {
    expect(
      localDbViolations({
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost:54322/postgres",
      }),
    ).toEqual([]);
  });

  it("refuses a hosted Supabase URL", () => {
    const out = localDbViolations({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd.supabase.co" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("abcd.supabase.co");
  });

  it("refuses a remote database URL, even with a local one also set", () => {
    const out = localDbViolations({
      SUPABASE_DB_URL: "postgresql://postgres:x@localhost:54322/postgres",
      DATABASE_URL: "postgresql://u:p@db.example.com:5432/app",
    });
    expect(out).toEqual([expect.stringContaining("db.example.com")]);
  });

  it("refuses look-alike hosts", () => {
    expect(
      localDbViolations({ DATABASE_URL: "postgresql://u@localhost.evil.com/db" }),
    ).toHaveLength(1);
  });

  it("refuses an unparsable URL", () => {
    expect(localDbViolations({ DATABASE_URL: "not a url" })).toHaveLength(1);
  });

  it("refuses --linked and --db-url flags", () => {
    expect(localDbViolations({}, ["--linked"])).toHaveLength(1);
    expect(localDbViolations({}, ["--db-url=postgresql://x@h/db"])).toHaveLength(1);
    expect(localDbViolations({}, ["--db-url", "postgresql://x@h/db"])).toHaveLength(1);
  });
});
