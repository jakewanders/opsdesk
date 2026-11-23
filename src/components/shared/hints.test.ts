import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe("field hints", () => {
  it('never write "Optional." with a full stop', () => {
    const offenders = sources("src").filter((f) =>
      /["'`>]Optional\.(?:\s|["'`<])/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
