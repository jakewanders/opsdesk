import { ACTIONS, MATRIX, ROLES, type Cell } from "./matrix";

const cell = (c: Cell): string =>
  c.allow
    ? c.constraints && c.constraints.length > 0
      ? `yes (${c.constraints.join(", ")})`
      : "yes"
    : "no";

/** The matrix as a Markdown table, for docs/SECURITY.md (a test keeps the doc in sync). */
export function renderMatrixMarkdown(): string {
  const header = ["Action", ...ROLES, "demo guest"];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const action of ACTIONS) {
    const rule = MATRIX[action];
    const onlyDemo = "onlyIn" in rule && rule.onlyIn === "demo";
    const roleCells = ROLES.map((role) =>
      onlyDemo ? (role === "owner" ? "demo only" : "no") : cell(rule.roles[role]),
    );
    lines.push(`| \`${action}\` | ${roleCells.join(" | ")} | ${cell(rule.demo)} |`);
  }
  return lines.join("\n");
}
