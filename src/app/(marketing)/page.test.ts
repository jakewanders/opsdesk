import { describe, expect, it } from "vitest";
import { metadata } from "./page";

describe("landing page metadata", () => {
  it("sets a title, description, and canonical from the configured origin", () => {
    expect(metadata.title).toContain("OpsDesk");
    expect(metadata.description).toMatch(/Customers, pipeline, quotes, tasks, and insights/);
    // NEXT_PUBLIC_APP_URL is unset in tests, so the origin falls back to localhost.
    expect(String(metadata.metadataBase)).toBe("http://localhost:3000/");
    expect(metadata.alternates?.canonical).toBe("/");
  });
});
