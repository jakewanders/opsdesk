import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnvNames, nameViolations, publicNamesIn } from "./env-names.mjs";

describe("env naming guard", () => {
  it("accepts safe public names", () => {
    expect(
      nameViolations([
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_ENABLE_AI",
      ]),
    ).toEqual([]);
  });

  it.each([
    "NEXT_PUBLIC_SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SERVICE_ROLE",
    "NEXT_PUBLIC_STRIPE_WEBHOOK_URL",
  ])("rejects %s", (name) => {
    expect(nameViolations([name])).toHaveLength(1);
  });

  it("extracts names from text", () => {
    expect(
      publicNamesIn("a NEXT_PUBLIC_A_B=1\nprocess.env.NEXT_PUBLIC_C x NEXT_PUBLIC_A_B"),
    ).toEqual(["NEXT_PUBLIC_A_B", "NEXT_PUBLIC_C"]);
  });

  it("flags a bad name found in a scanned file and in the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "envnames-"));
    writeFileSync(join(dir, ".env.example"), "NEXT_PUBLIC_API_SECRET=\nNEXT_PUBLIC_OK=1\n");
    expect(checkEnvNames([dir])).toEqual([expect.stringContaining("NEXT_PUBLIC_API_SECRET")]);
    expect(checkEnvNames([], { NEXT_PUBLIC_X_SERVICE_KEY: "1" })).toHaveLength(1);
  });

  it("passes on the real repository config", () => {
    expect(checkEnvNames([".env.example", "src", "scripts"], {})).toEqual([]);
  });
});
