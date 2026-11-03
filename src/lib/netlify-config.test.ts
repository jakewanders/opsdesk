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

  it("names the custom domain only as the target of the netlify.app redirect, and never the apex", () => {
    const withoutRedirect = toml
      .replace(/\[\[redirects\]\][\s\S]*$/, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(withoutRedirect).not.toContain("sitelaunch.dev");
    const redirect = /\[\[redirects\]\][\s\S]*$/.exec(toml)?.[0] ?? "";
    expect(redirect).toMatch(/from = "https:\/\/sitelaunch-opsdesk\.netlify\.app\/\*"/);
    expect(redirect).toMatch(/to = "https:\/\/opsdesk\.sitelaunch\.dev\/:splat"/);
    expect(redirect).toMatch(/status = 301/);
    // the only hosts in the file: the netlify.app production host and the custom subdomain; no apex, www or wildcard
    const hosts = [...toml.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
    for (const h of hosts)
      expect(["sitelaunch-opsdesk.netlify.app", "opsdesk.sitelaunch.dev"]).toContain(h);
  });
});
