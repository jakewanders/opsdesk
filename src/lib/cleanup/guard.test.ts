import { describe, expect, it } from "vitest";
import { evaluateCleanupTarget, exitCodeFor } from "./guard";

const KEY = "sb_secret_test_value";

describe("evaluateCleanupTarget [SIT-213]", () => {
  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"])(
    "a local project (%s) runs without a confirmation",
    (url) => {
      const t = evaluateCleanupTarget({ url, secretKey: KEY });
      expect(t).toMatchObject({ ok: true, local: true });
    },
  );

  it("refuses without a secret key or without a URL, naming what to set (never the value)", () => {
    expect(
      evaluateCleanupTarget({ url: "http://127.0.0.1:54321", secretKey: undefined }),
    ).toMatchObject({ ok: false, code: "MISSING_SECRET" });
    expect(evaluateCleanupTarget({ url: "http://127.0.0.1:54321", secretKey: "" })).toMatchObject({
      ok: false,
      code: "MISSING_SECRET",
    });
    expect(evaluateCleanupTarget({ url: undefined, secretKey: KEY })).toMatchObject({
      ok: false,
      code: "MISSING_URL",
    });
    expect(evaluateCleanupTarget({ url: "not a url", secretKey: KEY })).toMatchObject({
      ok: false,
      code: "BAD_URL",
    });
  });

  it("a remote project is refused until the command repeats its exact hostname", () => {
    const url = "https://abcd1234.supabase.co";
    const refused = evaluateCleanupTarget({ url, secretKey: KEY });
    expect(refused).toMatchObject({ ok: false, code: "CONFIRM_REQUIRED" });
    expect((refused as { message: string }).message).toContain(
      "--confirm-remote abcd1234.supabase.co",
    );
    expect(
      evaluateCleanupTarget({ url, secretKey: KEY, confirmRemote: "other.supabase.co" }),
    ).toMatchObject({ ok: false, code: "CONFIRM_REQUIRED" });
    expect(evaluateCleanupTarget({ url, secretKey: KEY, confirmRemote: "" })).toMatchObject({
      ok: false,
    });
    expect(
      evaluateCleanupTarget({ url, secretKey: KEY, confirmRemote: "ABCD1234.supabase.co" }),
    ).toMatchObject({ ok: true, local: false, host: "abcd1234.supabase.co" });
  });

  it("a hostname that merely contains 'localhost' is not local", () => {
    for (const url of [
      "https://localhost.evil.example",
      "https://127.0.0.1.evil.example",
      "https://evil.example/localhost",
    ])
      expect(evaluateCleanupTarget({ url, secretKey: KEY })).toMatchObject({
        ok: false,
        code: "CONFIRM_REQUIRED",
      });
  });

  it("the scheduled function needs no flag but still needs both variables", () => {
    expect(
      evaluateCleanupTarget({
        url: "https://abcd1234.supabase.co",
        secretKey: KEY,
        scheduled: true,
      }),
    ).toMatchObject({ ok: true, local: false });
    expect(
      evaluateCleanupTarget({
        url: "https://abcd1234.supabase.co",
        secretKey: undefined,
        scheduled: true,
      }),
    ).toMatchObject({ ok: false, code: "MISSING_SECRET" });
  });

  it("the messages never contain the secret key", () => {
    const all = [
      evaluateCleanupTarget({ url: "https://x.supabase.co", secretKey: KEY }),
      evaluateCleanupTarget({ url: "bad", secretKey: KEY }),
    ];
    for (const r of all) expect(JSON.stringify(r)).not.toContain(KEY);
  });
});

describe("exitCodeFor", () => {
  it("any error fails the run; stopping at the time budget does not (the next run continues)", () => {
    expect(exitCodeFor({ errors: 0, truncated: false })).toBe(0);
    expect(exitCodeFor({ errors: 0, truncated: true })).toBe(0);
    expect(exitCodeFor({ errors: 2, truncated: false })).toBe(1);
  });
});
