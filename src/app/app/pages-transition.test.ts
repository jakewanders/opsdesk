// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

describe("page transitions", () => {
  it("every /app page that renders something is wrapped in PageTransition (a redirect has nothing to animate)", () => {
    const offenders = pages(join(process.cwd(), "src/app/app")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        !text.includes("PageTransition") &&
        !/\bredirect\(/.test(text.split("export default")[1] ?? "")
      );
    });
    expect(offenders).toEqual([]);
  });
});
