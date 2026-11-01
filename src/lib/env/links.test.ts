import { describe, expect, it } from "vitest";
import { getAppOrigin, getRepoUrl, parseHttpUrl } from "./links";

describe("getRepoUrl", () => {
  it("is undefined when unset or blank", () => {
    expect(getRepoUrl(undefined)).toBeUndefined();
    expect(getRepoUrl("")).toBeUndefined();
    expect(getRepoUrl("   ")).toBeUndefined();
  });
  it("returns a valid http(s) URL", () => {
    expect(getRepoUrl("https://github.com/example/repo")).toBe("https://github.com/example/repo");
  });
  it("rejects malformed values and dangerous schemes instead of throwing", () => {
    expect(getRepoUrl("not a url")).toBeUndefined();
    expect(getRepoUrl("javascript:alert(1)")).toBeUndefined();
    expect(getRepoUrl("ftp://example.com/repo")).toBeUndefined();
  });
});

describe("getAppOrigin", () => {
  it("defaults to localhost", () => {
    expect(getAppOrigin(undefined).origin).toBe("http://localhost:3000");
    expect(getAppOrigin("garbage").origin).toBe("http://localhost:3000");
  });
  it("reads the configured origin", () => {
    expect(getAppOrigin("https://opsdesk.sitelaunch.dev").origin).toBe(
      "https://opsdesk.sitelaunch.dev",
    );
  });
});

describe("parseHttpUrl", () => {
  it("trims", () => {
    expect(parseHttpUrl("  https://a.example/x ")?.hostname).toBe("a.example");
  });
});
