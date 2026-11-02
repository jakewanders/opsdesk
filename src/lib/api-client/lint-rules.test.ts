import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/** The repository's own ESLint config must reject dangerouslySetInnerHTML (PRD 9.3: free text is rendered as text). */
async function lint(code: string) {
  const eslint = new ESLint({ cwd: process.cwd() });
  const [result] = await eslint.lintText(code, { filePath: "src/components/shared/zz-probe.tsx" });
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax");
}

describe("lint: no dangerouslySetInnerHTML", () => {
  it("rejects it as a JSX prop", async () => {
    const messages = await lint(
      `export const A = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].message).toContain("dangerouslySetInnerHTML");
  });
  it("rejects it passed as a props object", async () => {
    const messages = await lint(
      `import { createElement } from "react";\nexport const a = (h: string) => createElement("div", { dangerouslySetInnerHTML: { __html: h } });\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });
  it("accepts plain text rendering", async () => {
    expect(await lint(`export const A = ({ t }: { t: string }) => <p>{t}</p>;\n`)).toEqual([]);
  });
});
