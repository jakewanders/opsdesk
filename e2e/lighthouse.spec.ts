import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { cleanUp, trackBrowserUser } from "./support/local";

/**
 * [P-09] Lighthouse on the key pages, desktop and phone presets, against the LOCAL production build, signed in as a guest for the
 * app pages. Off by default (it takes minutes and its numbers depend on the machine):
 *
 *   LIGHTHOUSE=1 node scripts/e2e.mjs e2e/lighthouse.spec.ts --project=desktop
 *
 * Writes test-results/lighthouse.json (every score, and the failing accessibility audits by page) and prints a table. It asserts
 * only what is a correctness property: accessibility >= 90 on every tested page (the PRD target) and no failing accessibility
 * audit worth a fix; performance numbers are recorded, not asserted, because they are local-machine numbers.
 */
test.skip(!process.env.LIGHTHOUSE, "set LIGHTHOUSE=1 to run the Lighthouse audit");
test.afterAll(cleanUp);

const BASE = "http://localhost:3111";
type Row = {
  page: string;
  preset: string;
  a11y: number;
  perf: number;
  bp: number;
  seo: number;
  lcp: string;
  cls: string;
  failing: string[];
};

test("lighthouse: accessibility is at least 90 on every key page, in both presets", async () => {
  test.setTimeout(45 * 60_000);
  const out = mkdtempSync(join(tmpdir(), "lh-out-"));
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: BASE });
  const rows: Row[] = [];
  try {
    const page = await context.newPage();
    await page.goto("/");
    await page.getByRole("link", { name: "Try Live Demo" }).first().click();
    await page.waitForURL(/\/app/, { timeout: 60_000 });
    const list = async (path: string) =>
      ((await (await page.request.get(`/api/v1${path}`)).json()) as { data: Array<{ id: string }> })
        .data;
    const cid = (await list("/customers?limit=1"))[0].id;
    const oid = (await list("/opportunities?limit=1"))[0].id;
    const qid = (await list("/quotes?limit=1"))[0]?.id;
    await trackBrowserUser(context);
    // Lighthouse starts its own headless Chrome; the guest session goes in as a Cookie header on every request it makes
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const pages = [
      "/",
      "/login",
      "/signup",
      "/privacy",
      "/terms",
      "/app",
      "/app/customers",
      `/app/customers/${cid}`,
      "/app/opportunities?view=list",
      "/app/opportunities?view=board",
      `/app/opportunities/${oid}`,
      "/app/tasks",
      "/app/quotes",
      ...(qid ? [`/app/quotes/${qid}`] : []),
      "/app/reports",
      "/app/activity",
      "/app/settings/members",
    ];
    for (const preset of ["desktop", "mobile"]) {
      for (const path of pages) {
        const file = join(out, `${preset}-${path.replace(/\W+/g, "_")}.json`);
        execFileSync(
          "npx",
          [
            "--yes",
            "lighthouse@12.6.1",
            `${BASE}${path}`,
            "--chrome-flags=--headless=new",
            `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
            "--output=json",
            `--output-path=${file}`,
            "--only-categories=accessibility,performance,best-practices,seo",
            "--disable-storage-reset",
            "--quiet",
            ...(preset === "desktop" ? ["--preset=desktop"] : []),
          ],
          {
            stdio: "ignore",
            env: { ...process.env, CHROME_PATH: chromium.executablePath() },
            timeout: 180_000,
          },
        );
        const lh = JSON.parse(readFileSync(file, "utf8"));
        const score = (k: string) => Math.round((lh.categories[k]?.score ?? 0) * 100);
        const failing = (
          lh.categories.accessibility.auditRefs as Array<{ id: string; weight: number }>
        )
          .filter(
            (r) => r.weight > 0 && lh.audits[r.id].score !== null && lh.audits[r.id].score < 1,
          )
          .map((r) => r.id);
        rows.push({
          page: path,
          preset,
          a11y: score("accessibility"),
          perf: score("performance"),
          bp: score("best-practices"),
          seo: score("seo"),
          lcp: lh.audits["largest-contentful-paint"].displayValue,
          cls: lh.audits["cumulative-layout-shift"].displayValue,
          failing,
        });
      }
    }
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/lighthouse.json", JSON.stringify(rows, null, 2));
  console.log(
    [
      "| preset | page | a11y | perf | best practices | SEO | LCP | CLS | failing a11y audits |",
      "|---|---|---|---|---|---|---|---|---|",
    ]
      .concat(
        rows.map(
          (r) =>
            `| ${r.preset} | ${r.page} | ${r.a11y} | ${r.perf} | ${r.bp} | ${r.seo} | ${r.lcp} | ${r.cls} | ${r.failing.join(", ") || "none"} |`,
        ),
      )
      .join("\n"),
  );
  for (const r of rows) {
    expect(r.a11y, `${r.preset} ${r.page}`).toBeGreaterThanOrEqual(90);
    expect(r.failing, `${r.preset} ${r.page}`).toEqual([]);
  }
});
