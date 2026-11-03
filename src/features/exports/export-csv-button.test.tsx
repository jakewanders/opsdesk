import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import { ExportCsvButton } from "./export-csv-button";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));
const saveBlob = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client/save-file", () => ({ saveBlob }));

let calls: string[];
let respond: () => Response | Promise<Response>;
beforeEach(() => {
  calls = [];
  notify.error.mockClear();
  notify.success.mockClear();
  saveBlob.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push(
      `${init?.method ?? "GET"} ${url.pathname}${url.search} org=${(init?.headers as Record<string, string>)?.["X-Organization-Id"]}`,
    );
    return respond();
  });
  respond = () =>
    new Response("id,title\r\n", {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="tasks-2026-11-03.csv"',
      },
    });
});
afterEach(() => vi.restoreAllMocks());

const view = (
  query: Record<string, string | number | undefined> = { status: "todo", sort: "due_date" },
) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <ExportCsvButton entity="tasks" query={query} noun="task list" />
    </ApiClientProvider>,
  );

describe("ExportCsvButton [P-01]", () => {
  it("asks the export API for the view's own filters and sort, in the active workspace, and saves the file under the server's name", async () => {
    const user = userEvent.setup();
    view({ status: "todo", sort: "due_date", q: undefined });
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
    expect(calls).toEqual(["GET /api/v1/exports/tasks?status=todo&sort=due_date org=org-1"]);
    expect(saveBlob.mock.calls[0][1]).toBe("tasks-2026-11-03.csv");
    expect(notify.success).toHaveBeenCalledWith("Task list exported", "tasks-2026-11-03.csv");
  });

  it("shows progress while the file is prepared and cannot be started twice", async () => {
    let release!: () => void;
    respond = () => new Promise((r) => (release = () => r(new Response("x", { status: 200 }))));
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    const busy = await screen.findByRole("button", { name: "Preparing CSV…" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    release();
    await screen.findByRole("button", { name: "Export CSV" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces the row-cap message in the server's own words, with the request id", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          error: {
            code: "EXPORT_TOO_LARGE",
            message:
              "This export has 10,001 rows; the limit is 10,000. Add filters to narrow it and try again.",
            requestId: "req-77",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      );
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(notify.error).toHaveBeenCalledWith(
      "The task list could not be exported",
      "This export has 10,001 rows; the limit is 10,000. Add filters to narrow it and try again. (request req-77)",
    );
    expect(saveBlob).not.toHaveBeenCalled();
    // and it can be tried again
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
  });

  it("a network failure is said in words", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const user = userEvent.setup();
    view();
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(notify.error).toHaveBeenCalled());
    expect(notify.error.mock.calls[0][0]).toBe("The task list could not be exported");
  });

  it("is a labelled button with no accessibility violations", async () => {
    const { container } = view();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
    await expectNoA11yViolations(container);
  });
});
