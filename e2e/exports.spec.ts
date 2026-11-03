import { readFileSync } from "node:fs";
import { expect, test, type Download, type Page } from "@playwright/test";
import { parseCsv } from "../src/lib/csv/parse";
import { psql } from "../src/test/local-supabase";
import {
  addMember,
  api,
  cleanUp,
  makeUser,
  makeWorkspace,
  signIn,
  type Person,
} from "./support/local";

/**
 * [P-01, P-02] CSV export in a real browser: every list's Export CSV carries the filters and sort on screen (the file's rows are exactly
 * the visible rows), a viewer can export, the 10,000-row cap and a failure are said in words with the request id, and the reports page
 * exports the range it shows. Formula-like cells arrive inert.
 */
let owner: Person, viewer: Person;
let org = "";
const LIMITS = { maxDataRows: 20_000, maxColumns: 50, maxCellLength: 10_000 };
const data = async (res: Response) => ((await res.json()) as { data: Record<string, string> }).data;

test.beforeAll(async () => {
  [owner, viewer] = await Promise.all([makeUser("exo"), makeUser("exv")]);
  org = await makeWorkspace(owner, "E2E Export Co");
  addMember(org, viewer, "viewer");
  const c = await data(
    await api(owner, "POST", "/customers", org, { displayName: "Export Lead One", status: "lead" }),
  );
  await api(owner, "POST", "/customers", org, { displayName: "Export Lead Two", status: "lead" });
  await api(owner, "POST", "/customers", org, {
    displayName: '=HYPERLINK("http://x")',
    status: "active",
  });
  await api(owner, "POST", "/customers", org, { displayName: "Export Active", status: "active" });
  for (const [title, stage, amount] of [
    ["Export Deal A", "proposal", 100000],
    ["Export Deal B", "new", 5000],
    ["Export Deal C", "proposal", 250000],
  ] as const)
    await api(owner, "POST", "/opportunities", org, {
      customerId: c.id,
      title,
      stage,
      amountCents: amount,
    });
  for (const [title, due] of [
    ["Export Task B", "2030-02-01"],
    ["Export Task A", "2030-01-01"],
    ["+cmd task", "2030-03-01"],
  ])
    await api(owner, "POST", "/tasks", org, { title, dueDate: due, customerId: c.id });
});
test.afterAll(cleanUp);

async function exportRows(page: Page, trigger: () => Promise<void>) {
  const [file] = await Promise.all([page.waitForEvent("download"), trigger()]);
  return readCsv(file);
}
async function readCsv(file: Download) {
  const text = readFileSync((await file.path()) as string, "utf8");
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""), LIMITS);
  return { name: file.suggestedFilename(), header, rows, col: (n: string) => header.indexOf(n) };
}
const tableTitles = (page: Page, linkPattern: RegExp) =>
  page.getByRole("table").getByRole("link", { name: linkPattern }).allInnerTexts();

test("customers: the file holds exactly the filtered, sorted rows on screen", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app/customers?status=lead&sort=display_name&order=asc");
  await expect(page.getByRole("link", { name: "Export Lead One" })).toBeVisible();
  const visible = (await tableTitles(page, /^Export Lead/)).map((s) =>
    s.replace(/\s*\(person\)\s*$/, "").trim(),
  );
  expect(visible).toEqual(["Export Lead One", "Export Lead Two"]);
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.name).toMatch(/^customers-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(file.rows.map((r) => r[file.col("display_name")])).toEqual(visible);
  expect(file.rows.every((r) => r[file.col("status")] === "lead")).toBe(true);
  await expect(page.getByText("Customer list exported")).toBeVisible();
});

test("customers: with no filter the file holds the formula-like name as inert text", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app/customers");
  await expect(page.getByRole("link", { name: "Export Active" })).toBeVisible();
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  const names = file.rows.map((r) => r[file.col("display_name")]);
  expect(names).toContain(`'=HYPERLINK("http://x")`);
  expect(names).not.toContain(`=HYPERLINK("http://x")`);
  for (const row of file.rows) for (const cell of row) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
});

test("opportunities: the list view's stage filter and sort are in the file", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app/opportunities?view=list&stage=proposal&sort=amount_cents&order=desc");
  await expect(page.getByRole("link", { name: "Export Deal C" })).toBeVisible();
  const visible = (await tableTitles(page, /^Export Deal/)).map((s) => s.trim());
  expect(visible).toEqual(["Export Deal C", "Export Deal A"]);
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.rows.map((r) => r[file.col("title")])).toEqual(visible);
  expect(file.rows.map((r) => r[file.col("amount_cents")])).toEqual(["250000", "100000"]);
});

test("the pipeline board exports the deals its search shows", async ({ page, context }) => {
  await signIn(context, owner);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/app/opportunities?view=board");
  await expect(page.getByText("Export Deal A").first()).toBeVisible();
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.rows.map((r) => r[file.col("title")]).sort()).toEqual([
    "Export Deal A",
    "Export Deal B",
    "Export Deal C",
  ]);
});

test("tasks: the file follows the list's order, and a viewer can export too", async ({
  page,
  context,
}) => {
  await signIn(context, viewer);
  await page.goto("/app/tasks?sort=due_date&order=asc");
  await expect(page.getByText("Export Task A").first()).toBeVisible();
  const exportButton = page.getByRole("button", { name: "Export CSV" });
  await expect(exportButton).toBeEnabled();
  const file = await exportRows(page, () => exportButton.click());
  const titles = file.rows.map((r) => r[file.col("title")]);
  // the order is the list endpoint's own; the formula-like title arrives with a leading quote
  const listed = (
    await (
      await page.request.get("/api/v1/tasks?sort=due_date&order=asc&limit=100", {
        headers: { "X-Organization-Id": org },
      })
    ).json()
  ).data.map((t: { title: string }) => (/^[=+\-@]/.test(t.title) ? `'${t.title}` : t.title));
  expect(titles).toEqual(listed);
  expect(titles).toContain("'+cmd task");
  expect(titles).toHaveLength(3);
});

test("a viewer can export the report and the file matches the API's numbers for the range", async ({
  page,
  context,
}) => {
  await signIn(context, viewer);
  await page.goto("/app/reports?range=7");
  await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  const report = (
    await (
      await page.request.get("/api/v1/reports?range=7", { headers: { "X-Organization-Id": org } })
    ).json()
  ).data;
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.header).toEqual([
    "section",
    "key",
    "period_start",
    "period_end",
    "metric",
    "value",
    "exported_at",
  ]);
  const created = file.rows.filter((r) => r[0] === "series" && r[4] === "opportunitiesCreated");
  expect(created).toHaveLength(report.buckets.length);
  expect(created.reduce((n, r) => n + Number(r[5]), 0)).toBe(
    report.buckets.reduce(
      (n: number, b: { opportunitiesCreated: number }) => n + b.opportunitiesCreated,
      0,
    ),
  );
  expect(created.reduce((n, r) => n + Number(r[5]), 0)).toBeGreaterThanOrEqual(3); // the three deals made in setup
  // change the range: the page and the next file follow
  await page.locator("label", { hasText: /^90 days$/ }).click();
  await expect(page).toHaveURL(/range=90$/);
  const file30 = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file30.rows.filter((r) => r[0] === "series" && r[4] === "tasksCompleted")).toHaveLength(
    13, // 90 days in 7-day buckets
  );
});

test("a failed export is said in words with the request id, and can be tried again", async ({
  page,
  context,
}) => {
  await signIn(context, owner);
  await page.goto("/app/tasks");
  await expect(page.getByText("Export Task A").first()).toBeVisible();
  let fail = true;
  await page.route("**/api/v1/exports/tasks**", (route) =>
    fail
      ? route.fulfill({
          status: 422,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "EXPORT_TOO_LARGE",
              message:
                "This export has 10,001 rows; the limit is 10,000. Add filters to narrow it and try again.",
              requestId: "req-e2e-1",
            },
          }),
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText("The task list could not be exported")).toBeVisible();
  await expect(
    page.getByText(/10,001 rows; the limit is 10,000.*\(request req-e2e-1\)/),
  ).toBeVisible();
  fail = false;
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.rows.length).toBe(3);
});

test("a list over 10,000 rows is refused in words, and a filter brings it back under", async ({
  page,
  context,
}) => {
  const bigOwner = await makeUser("exb");
  const big = await makeWorkspace(bigOwner, "E2E Export Big Co");
  psql("alter table public.customers disable trigger user");
  try {
    psql(`insert into public.customers (organization_id, display_name)
      select '${big}', 'Big ' || lpad(i::text, 5, '0') from generate_series(1, 10001) i`);
  } finally {
    psql("alter table public.customers enable trigger user");
  }
  await signIn(context, bigOwner);
  await page.goto("/app/customers?sort=display_name&order=asc");
  await expect(page.getByRole("link", { name: /^Big 00001/ }).first()).toBeVisible();
  await page.getByRole("button", { name: "Export CSV" }).click();
  await expect(page.getByText("The customer list could not be exported")).toBeVisible();
  await expect(page.getByText(/10,001 rows; the limit is 10,000\. Add filters/)).toBeVisible();
  await page.goto("/app/customers?q=big%200004&sort=display_name&order=asc"); // Big 00040 to Big 00049
  await expect(page.getByRole("link", { name: /^Big 00040/ }).first()).toBeVisible();
  const file = await exportRows(page, () =>
    page.getByRole("button", { name: "Export CSV" }).click(),
  );
  expect(file.rows).toHaveLength(10);
});
