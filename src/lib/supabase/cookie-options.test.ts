import { describe, expect, it } from "vitest";
import { authCookieOptions } from "./cookie-options";

describe("authCookieOptions", () => {
  const prod = authCookieOptions(new URL("https://opsdesk.sitelaunch.dev"));
  const local = authCookieOptions(new URL("http://localhost:3000"));

  it("is Secure when the app origin is https", () => {
    expect(prod.secure).toBe(true);
  });

  it("is not Secure on http://localhost so local development works in every browser", () => {
    expect(local.secure).toBe(false);
  });

  it("is host-scoped: never sets a Domain, so sitelaunch.dev and its subdomains never receive it", () => {
    expect(prod).not.toHaveProperty("domain");
    expect(local).not.toHaveProperty("domain");
  });

  it("uses SameSite=Lax on the whole site", () => {
    expect(prod.sameSite).toBe("lax");
    expect(prod.path).toBe("/");
  });

  it("is readable by the browser client (documented tradeoff), with a bounded lifetime", () => {
    expect(prod.httpOnly).toBe(false);
    expect(prod.maxAge).toBe(400 * 24 * 60 * 60);
  });

  it("defaults to the configured app origin", () => {
    expect(authCookieOptions().secure).toBe(false); // NEXT_PUBLIC_APP_URL is unset in tests
  });
});
