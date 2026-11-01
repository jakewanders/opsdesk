import { describe, expect, it } from "vitest";
import {
  EnvError,
  PRODUCTION_ORIGIN,
  parsePublicEnv,
  parseServerEnv,
  toFeatureFlags,
} from "@/lib/env/schema";

const base = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};

describe("parsePublicEnv", () => {
  it("accepts the minimum and applies defaults", () => {
    const env = parsePublicEnv(base);
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
    expect(toFeatureFlags(env)).toEqual({
      quotes: true,
      csvImport: true,
      billing: false,
      email: false,
      ai: false,
      integrations: false,
    });
  });

  it("fails fast naming every missing required variable", () => {
    let error: unknown;
    try {
      parsePublicEnv({});
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EnvError);
    const message = (error as EnvError).message;
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL is required");
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required");
    expect(message).toContain(".env.example");
  });

  it("treats empty strings (a copied .env.example) as unset", () => {
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required/,
    );
    expect(parsePublicEnv({ ...base, NEXT_PUBLIC_APP_URL: "" }).NEXT_PUBLIC_APP_URL).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects a malformed URL", () => {
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    );
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_SUPABASE_URL: "ftp://x.example" })).toThrow(
      /starting with http/,
    );
  });

  it("parses flags case-insensitively and rejects garbage", () => {
    const env = parsePublicEnv({
      ...base,
      NEXT_PUBLIC_ENABLE_QUOTES: "FALSE",
      NEXT_PUBLIC_ENABLE_AI: "1",
      NEXT_PUBLIC_ENABLE_BILLING: "no",
    });
    expect(toFeatureFlags(env)).toMatchObject({ quotes: false, ai: true, billing: false });
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_ENABLE_EMAIL: "maybe" })).toThrow(
      /NEXT_PUBLIC_ENABLE_EMAIL must be true or false/,
    );
  });

  it("requires https for a non-local app URL", () => {
    expect(() => parsePublicEnv({ ...base, NEXT_PUBLIC_APP_URL: "http://example.com" })).toThrow(
      /https/,
    );
    expect(parsePublicEnv({ ...base, NEXT_PUBLIC_APP_URL: "https://example.com" })).toBeTruthy();
  });

  it("enforces the production origin on production deploys only", () => {
    const preview = { ...base, NEXT_PUBLIC_APP_URL: "https://deploy-preview-1--site.netlify.app" };
    expect(parsePublicEnv(preview, "deploy-preview")).toBeTruthy();
    expect(() => parsePublicEnv(preview, "production")).toThrow(new RegExp(PRODUCTION_ORIGIN));
    expect(
      parsePublicEnv({ ...base, NEXT_PUBLIC_APP_URL: PRODUCTION_ORIGIN }, "production"),
    ).toBeTruthy();
  });
});

describe("parseServerEnv", () => {
  it("allows everything unset", () => {
    expect(parseServerEnv({})).toMatchObject({});
  });

  it("keeps provided secrets and drops empties", () => {
    const env = parseServerEnv({ SUPABASE_SECRET_KEY: "sb_secret_x", STRIPE_SECRET_KEY: "" });
    expect(env.SUPABASE_SECRET_KEY).toBe("sb_secret_x");
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
  });
});
