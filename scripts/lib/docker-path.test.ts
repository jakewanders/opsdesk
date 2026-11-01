import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { withDockerPath } from "./docker-path.mjs";

describe("withDockerPath", () => {
  it("keeps the existing PATH entries in order", () => {
    const dir = mkdtempSync(`${tmpdir()}/p-`);
    const env = withDockerPath({ PATH: `${dir}${delimiter}/usr/bin` });
    expect(env.PATH?.startsWith(`${dir}${delimiter}/usr/bin`)).toBe(true);
  });

  it("does not duplicate a directory that is already on PATH", () => {
    const once = withDockerPath({ PATH: "/usr/bin" });
    const twice = withDockerPath(once);
    expect(twice.PATH).toBe(once.PATH);
  });

  it("preserves other variables and handles a missing PATH", () => {
    const env = withDockerPath({ FOO: "bar" });
    expect(env.FOO).toBe("bar");
    expect(typeof env.PATH).toBe("string");
  });
});
