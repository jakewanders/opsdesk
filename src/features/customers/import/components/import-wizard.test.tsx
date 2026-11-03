import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { ImportPreview, ImportResult } from "../types";
import { ImportWizard } from "./import-wizard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/app/customers/import",
  useSearchParams: () => new URLSearchParams(),
}));

const JOB = "11111111-1111-4111-8111-111111111111";
const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  importJobId: JOB,
  status: "previewed",
  fileSha256: "a".repeat(64),
  expiresAt: "2026-11-03T05:00:00Z",
  counts: { total: 5, valid: 3, invalid: 2 },
  columns: {
    mapped: [
      { header: "display_name", field: "displayName" },
      { header: "email", field: "email" },
    ],
    unknown: ["favorite_color"],
  },
  rows: [
    {
      row: 2,
      valid: true,
      values: { displayName: "Ada Lovelace", email: "ada@x.test" },
      errors: [],
      warnings: [],
    },
    { row: 3, valid: false, values: { email: "bad" }, errors: [], warnings: [] },
  ],
  errors: [
    { row: 3, field: "displayName", code: "REQUIRED", message: "Enter a name." },
    { row: 4, field: "email", code: "INVALID_EMAIL", message: "Enter a valid email address." },
  ],
  errorsTruncated: false,
  warnings: [
    {
      row: 5,
      field: "email",
      code: "DUPLICATE_EXISTING",
      message: "A customer in this workspace already uses this email address.",
    },
  ],
  warningsTruncated: false,
  demo: null,
  ...over,
});
const result = (over: Partial<ImportResult> = {}): ImportResult => ({
  importJobId: JOB,
  status: "committed",
  replayed: false,
  total: 5,
  imported: 2,
  rejected: 2,
  skippedDuplicates: 1,
  failedChunks: [],
  failedRows: 0,
  demoCapReached: false,
  notImportedDemoCap: 0,
  ...over,
});

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; init: RequestInit }>;
function mockApi(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    calls.push({ url: String(u), init: init ?? {} });
    return handler(String(u), init ?? {});
  });
}
const posts = (suffix: string) =>
  calls.filter((c) => c.init.method === "POST" && c.url.endsWith(suffix));
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));
const CSV = "display_name,email\nAda Lovelace,ada@x.test\n";
const csvFile = (content = CSV, name = "customers.csv") =>
  new File([content], name, { type: "text/csv" });

const renderWizard = (isDemo = false) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <ImportWizard isDemo={isDemo} />
    </ApiClientProvider>,
  );
async function toReview(user: ReturnType<typeof userEvent.setup>, p = preview()) {
  mockApi((url) =>
    url.endsWith("/preview")
      ? respond(201, { data: p, meta: {} })
      : respond(200, { data: result(), meta: {} }),
  );
  renderWizard();
  await user.upload(screen.getByLabelText("CSV file"), csvFile());
  await user.click(await screen.findByRole("button", { name: "Check the file" }));
  await screen.findByRole("heading", { name: /^Review/ });
}

beforeEach(() =>
  vi.stubGlobal("crypto", { randomUUID: () => "key-" + Math.random().toString(36).slice(2) }),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ImportWizard: step 1, choose a file", () => {
  it("explains the file, has a labelled input, a step list, and nothing to submit until a file is chosen", async () => {
    mockApi(() => respond(200, {}));
    const { container } = renderWizard();
    expect(screen.getByRole("heading", { level: 1, name: "Import customers" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Import steps" });
    expect(
      within(steps)
        .getByText(/Choose a file/)
        .closest("li"),
    ).toHaveAttribute("aria-current", "step");
    expect(screen.getByLabelText("CSV file")).toHaveAttribute("type", "file");
    expect(screen.getByText(/display_name/)).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is added yet: you review the file first."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check the file" })).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("refuses the wrong kind of file and an oversized one before uploading anything", async () => {
    mockApi(() => respond(200, {}));
    const user = userEvent.setup({ applyAccept: false });
    renderWizard();
    await user.upload(
      screen.getByLabelText("CSV file"),
      new File(["x"], "photo.png", { type: "image/png" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a CSV file");
    expect(screen.getByLabelText("CSV file")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Check the file" })).toBeDisabled();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("CSV file"), big);
    expect(await screen.findByRole("alert")).toHaveTextContent("larger than 2 MB");
    expect(calls).toHaveLength(0);
  });

  it("shows the chosen file, then posts it as base64 to the preview endpoint", async () => {
    mockApi(() => respond(201, { data: preview(), meta: {} }));
    const user = userEvent.setup();
    renderWizard();
    await user.upload(screen.getByLabelText("CSV file"), csvFile());
    expect(await screen.findByText(/customers\.csv/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check the file" }));
    await waitFor(() => expect(posts("/preview")).toHaveLength(1));
    expect(body(posts("/preview")[0])).toEqual({ content: Buffer.from(CSV).toString("base64") });
    expect(calls[0].init.headers).toMatchObject({ "X-Organization-Id": "org-1" });
  });

  it("says why the server refused a file", async () => {
    mockApi(() =>
      respond(422, {
        error: {
          code: "IMPORT_MISSING_COLUMN",
          message: 'The file needs a "display_name" column.',
          requestId: "req-3",
        },
      }),
    );
    const user = userEvent.setup();
    renderWizard();
    await user.upload(screen.getByLabelText("CSV file"), csvFile("email\na@x.test\n"));
    await user.click(await screen.findByRole("button", { name: "Check the file" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('needs a "display_name" column');
    expect(alert).toHaveTextContent("req-3");
    expect(screen.getByRole("heading", { name: "Choose a CSV file" })).toBeInTheDocument();
  });
});

describe("ImportWizard: step 2, review", () => {
  it("shows the counts, the columns, the first rows, the exact errors and the duplicate rows, and states what will happen", async () => {
    const user = userEvent.setup();
    await toReview(user);
    const stats = screen.getByText("Rows in the file").closest("dl")!;
    expect(within(stats).getByText("5")).toBeInTheDocument();
    expect(within(stats).getByText("Will be imported").nextSibling).toHaveTextContent("2"); // 3 valid, 1 repeats an email
    expect(screen.getByText(/Understood:/)).toHaveTextContent("display_name → Name");
    expect(screen.getByText(/Ignored \(not customer fields\): favorite_color/)).toBeInTheDocument();
    const rows = screen.getByRole("table", { name: /first rows/ });
    expect(within(rows).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(rows).getByText("Has errors")).toBeInTheDocument();
    const errors = screen.getByRole("table", { name: /cannot be imported/ });
    expect(within(errors).getByText("Enter a name.")).toBeInTheDocument();
    expect(within(errors).getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: /already in the workspace/ })).toBeInTheDocument();
    expect(screen.getByText(/will be imported\./)).toHaveTextContent(
      "2 customers will be imported",
    );
    expect(screen.getByText(/will be skipped/)).toHaveTextContent(
      "3 rows will be skipped: 2 with errors, 1 with a repeated email",
    );
    expect(screen.getByRole("button", { name: "Import 2 customers" })).toBeEnabled();
    expect(screen.getByRole("heading", { name: /^Review/ })).toHaveFocus();
    await expectNoA11yViolations(document.body);
  });

  it("downloads the error report for this job", async () => {
    const user = userEvent.setup();
    await toReview(user);
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = vi.fn();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    mockApi(
      () =>
        new Response("row,field,code,explanation\r\n", {
          status: 200,
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="import-errors-11111111.csv"',
          },
        }),
    );
    await user.click(screen.getByRole("button", { name: /Download error report/ }));
    await waitFor(() => expect(clicked).toEqual(["import-errors-11111111.csv"]));
    expect(calls[0].url).toBe(`/api/v1/imports/customers/${JOB}/errors`);
  });

  it("with nothing valid to import the button says so and is off", async () => {
    const user = userEvent.setup();
    await toReview(user, preview({ counts: { total: 2, valid: 0, invalid: 2 }, warnings: [] }));
    expect(screen.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
  });

  it("warns when a demo has room for only some of the rows", async () => {
    const user = userEvent.setup();
    await toReview(
      user,
      preview({
        counts: { total: 40, valid: 40, invalid: 0 },
        errors: [],
        warnings: [],
        demo: { remaining: 12, wouldExceed: true },
      }),
    );
    expect(screen.getByRole("note")).toHaveTextContent("room for 12 more");
    expect(screen.getByRole("note")).toHaveTextContent("other 28 rows would not be imported");
    expect(screen.getByRole("button", { name: "Import 12 customers" })).toBeEnabled();
  });

  it("a file that was already imported offers to show what happened, not to import", async () => {
    const user = userEvent.setup();
    await toReview(user, preview({ status: "committed" }));
    expect(screen.getByText(/already imported into this workspace/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show what happened" })).toBeEnabled();
  });

  it("choosing a different file goes back to step 1", async () => {
    const user = userEvent.setup();
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Choose a different file" }));
    expect(screen.getByRole("heading", { name: "Choose a CSV file" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Check the file" })).toBeDisabled();
  });
});

describe("ImportWizard: import and result", () => {
  it("imports once with the job and the file, an idempotency key, and shows the summary", async () => {
    const user = userEvent.setup();
    await toReview(user);
    await user.click(screen.getByRole("button", { name: "Import 2 customers" }));
    await screen.findByRole("heading", { name: "2 customers imported" });
    const commit = posts("/commit");
    expect(commit).toHaveLength(1);
    expect(body(commit[0])).toEqual({
      importJobId: JOB,
      content: Buffer.from(CSV).toString("base64"),
    });
    expect((commit[0].init.headers as Record<string, string>)["Idempotency-Key"]).toMatch(/^key-/);
    const stats = screen.getByText("Imported").closest("dl")!;
    expect(stats).toHaveTextContent("Imported2");
    expect(stats).toHaveTextContent("Skipped: repeated email1");
    expect(stats).toHaveTextContent("Skipped: errors2");
    expect(screen.getByRole("link", { name: "View imported customers" })).toHaveAttribute(
      "href",
      "/app/customers?sort=created_at&order=desc",
    );
    expect(screen.getByRole("heading", { name: "2 customers imported" })).toHaveFocus();
    await expectNoA11yViolations(document.body);
  });

  it("a double click sends one request", async () => {
    const user = userEvent.setup();
    await toReview(user);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockApi(async () => {
      await gate;
      return respond(200, { data: result(), meta: {} });
    });
    const button = screen.getByRole("button", { name: "Import 2 customers" });
    await user.dblClick(button);
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    release();
    await screen.findByRole("heading", { name: "2 customers imported" });
    expect(posts("/commit")).toHaveLength(1);
  });

  it("a failed attempt keeps the page, says so, and the retry reuses the same idempotency key", async () => {
    const user = userEvent.setup();
    await toReview(user);
    mockApi(() =>
      respond(500, {
        error: { code: "INTERNAL", message: "Something went wrong.", requestId: "req-8" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Import 2 customers" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("nothing is imported twice");
    expect(alert).toHaveTextContent("req-8");
    const firstKey = (posts("/commit")[0].init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    mockApi(() => respond(200, { data: result(), meta: {} }));
    await user.click(screen.getByRole("button", { name: "Import 2 customers" }));
    await screen.findByRole("heading", { name: "2 customers imported" });
    expect((posts("/commit")[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe(
      firstKey,
    );
  });

  it("a demo that hit its cap shows the partial result clearly", async () => {
    const user = userEvent.setup();
    await toReview(
      user,
      preview({
        counts: { total: 40, valid: 40, invalid: 0 },
        errors: [],
        warnings: [],
        demo: { remaining: 12, wouldExceed: true },
      }),
    );
    mockApi(() =>
      respond(429, {
        error: {
          code: "DEMO_CAP",
          message: "Demo limit reached: customers.",
          requestId: "r",
          meta: {
            result: result({
              imported: 12,
              rejected: 0,
              skippedDuplicates: 0,
              demoCapReached: true,
              notImportedDemoCap: 28,
            }),
          },
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Import 12 customers" }));
    await screen.findByRole("heading", { name: "12 customers imported" });
    expect(screen.getByRole("note")).toHaveTextContent(
      "reached its limit of 50 customers, so 28 rows could not be added",
    );
    expect(screen.getByText("Could not be saved").nextSibling).toHaveTextContent("28");
  });

  it("failed groups of rows are reported with what to do", async () => {
    const user = userEvent.setup();
    await toReview(user);
    mockApi(() =>
      respond(200, { data: result({ imported: 1, failedChunks: [1], failedRows: 100 }), meta: {} }),
    );
    await user.click(screen.getByRole("button", { name: "Import 2 customers" }));
    await screen.findByRole("heading", { name: "1 customer imported" });
    expect(screen.getByRole("alert")).toHaveTextContent("100 rows could not be saved");
    expect(screen.getByRole("button", { name: /Download error report/ })).toBeInTheDocument();
  });

  it("a repeat of an earlier import says nothing was added this time; 'Import another file' starts over", async () => {
    const user = userEvent.setup();
    await toReview(user, preview({ status: "committed" }));
    mockApi(() => respond(200, { data: result({ replayed: true }), meta: {} }));
    await user.click(screen.getByRole("button", { name: "Show what happened" }));
    await screen.findByRole("heading", { name: "This file was already imported" });
    expect(screen.getByRole("note")).toHaveTextContent("Nothing was added this time");
    await user.click(screen.getByRole("button", { name: "Import another file" }));
    expect(screen.getByRole("heading", { name: "Choose a CSV file" })).toBeInTheDocument();
  });

  it("a demo sees the limit stated on the first step", () => {
    mockApi(() => respond(200, {}));
    renderWizard(true);
    expect(screen.getByText(/demo: it holds up to 50 customers/)).toBeInTheDocument();
  });
});
