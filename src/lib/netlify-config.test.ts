// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const toml = readFileSync("netlify.toml", "utf8");
const nvmrc = readFileSync(".nvmrc", "utf8").trim();

describe("netlify.toml", () => {
  it("builds with npm run build and sets no publish directory", () => {
    expect(toml).toMatch(/^\s*command\s*=\s*"npm run build"/m);
    expect(toml).not.toMatch(/^\s*publish\s*=/m);
  });

  it("uses the same Node major as .nvmrc", () => {
    expect(toml).toMatch(new RegExp(`NODE_VERSION\\s*=\\s*"${nvmrc}"`));
  });

  it("holds no environment values at all: they live in the Netlify dashboard, per deploy context", () => {
    expect(toml).not.toMatch(/\[context\./);
    expect(toml).not.toMatch(/NEXT_PUBLIC_/);
  });

  it("contains only placeholder public values, never secrets", () => {
    const assignments = [...toml.matchAll(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [
      m[1],
      m[2],
    ]);
    for (const [name, value] of assignments) {
      if (name === "NODE_VERSION") continue;
      if (name === "command") continue;
      expect(name, `${name} must be a public variable`).toMatch(/^NEXT_PUBLIC_/);
      expect(value, name).toMatch(/placeholder/);
    }
    expect(toml).not.toMatch(/SECRET|SERVICE_ROLE|WEBHOOK|sb_secret|eyJ/);
  });

  it("does not attach the production origin or touch the apex domain", () => {
    expect(toml).not.toContain("sitelaunch.dev");
  });
});
