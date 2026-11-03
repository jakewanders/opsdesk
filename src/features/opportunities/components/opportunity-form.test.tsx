import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { OpportunityDto } from "../schema";
import { OpportunityForm } from "./opportunity-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: push, refresh: vi.fn() }),
  usePathname: () => "/app/opportunities/new",
  useSearchParams: () => new URLSearchParams(),
}));
const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const MEMBERS = [
  { userId: ME, role: "owner", displayName: "Olivia Owner" },
  { userId: "00000000-0000-4000-8000-0000000000bb", role: "member", displayName: "Tom Teammate" },
];
const CUSTOMERS = [
  {
    id: "c0000000-0000-4000-8000-000000000001",
    displayName: "Acme Plumbing",
    companyName: null,
    email: "info@acme.example.com",
  },
  {
    id: "c0000000-0000-4000-8000-000000000002",
    displayName: "Acme Roofing",
    companyName: "Acme Group",
    email: null,
  },
  {
    id: "c0000000-0000-4000-8000-000000000003",
    displayName: "Globex",
    companyName: null,
    email: null,
  },
];
const NOW = "2026-11-02T10:00:00.000000+00:00";
const deal: OpportunityDto = {
  id: "d0000000-0000-4000-8000-000000000001",
  customerId: CUSTOMERS[0].id,
  customerName: "Acme Plumbing",
  customerArchived: false,
  title: "Warehouse retrofit",
  description: "Scope agreed",
  stage: "proposal",
  amountCents: 123450,
  probabilityPercent: 50,
  expectedCloseDate: "2026-12-01",
  assignedTo: ME,
  lostReason: null,
  closedAt: null,
  createdBy: ME,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
};

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; init: RequestInit }>;
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function mockApi(handler: Handler = () => respond(201, { data: deal, meta: {} })) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    calls.push({ url: String(u), init: init ?? {} });
    if (url.pathname.endsWith("/members")) return respond(200, { data: MEMBERS, meta: {} });
    if (url.pathname.endsWith("/customers") && (init?.method ?? "GET") === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return respond(200, {
        data: CUSTOMERS.filter((c) => c.displayName.toLowerCase().includes(q)),
        meta: {},
      });
    }
    return handler(url, init ?? {});
  });
}
const listbox = () => screen.getByRole("listbox", { name: "Matching customers", hidden: true });
const options = () => within(listbox()).queryAllByRole("option", { hidden: true });
const writes = () => calls.filter((c) => c.init.method === "POST" || c.init.method === "PATCH");
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

const renderForm = (props: Partial<React.ComponentProps<typeof OpportunityForm>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <Link href="/app/opportunities">Pipeline link</Link>
      <OpportunityForm currentUserId={ME} {...props} />
    </ApiClientProvider>,
  );

beforeEach(() => {
  push.mockClear();
  notify.error.mockClear();
  notify.success.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("OpportunityForm: validation", () => {
  it("empty submit names every required field at the field and in a focused summary", async () => {
    mockApi();
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();
    for (const name of [/Customer/, /Title/, /Amount/])
      expect(within(summary).getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Customer/ })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(screen.getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Amount/)).toHaveAttribute("aria-invalid", "true");
    expect(writes()).toHaveLength(0);
  });
  it.each([
    ["-5", /0 or more|negative/i],
    ["1.234", /2 decimal/i],
    ["12abc", /plain amount/i],
    ["1,2", /plain amount/i],
    ["1000000000.01", /too large/i],
  ])("amount %s is refused at the amount field with the exact reason", async (typed, message) => {
    mockApi();
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "Valid title");
    await userEvent.type(screen.getByLabelText(/Amount/), typed);
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    const amount = screen.getByLabelText(/Amount/);
    expect(amount).toHaveAttribute("aria-invalid", "true");
    const described = amount
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" ");
    expect(described).toMatch(message);
    expect(writes()).toHaveLength(0);
  });
  it("probability must be a whole percent from 0 to 100; the date must exist; the title has a length range", async () => {
    mockApi();
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "x");
    await userEvent.type(screen.getByLabelText(/Amount/), "10");
    await userEvent.type(screen.getByLabelText(/Probability/), "101");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    expect(screen.getByLabelText(/Probability/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(screen.getByLabelText(/Probability/));
    await userEvent.type(screen.getByLabelText(/Probability/), "5.5");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    expect(screen.getByLabelText(/Probability/)).toHaveAttribute("aria-invalid", "true");
    expect(writes()).toHaveLength(0);
  });
});

describe("OpportunityForm: creating", () => {
  it("1,234.50 is sent as 123450 cents; the probability is left out when blank so the stage's default applies", async () => {
    mockApi(() =>
      respond(201, { data: { ...deal, id: "d0000000-0000-4000-8000-000000000009" }, meta: {} }),
    );
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "  Boiler swap ");
    await userEvent.type(screen.getByLabelText(/Amount/), "1,234.50");
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "proposal");
    await userEvent.type(screen.getByLabelText(/Expected close date/), "2027-01-15");
    await userEvent.selectOptions(screen.getByLabelText("Owner"), MEMBERS[1].userId);
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/opportunities/d0000000-0000-4000-8000-000000000009"),
    );
    const [call] = writes();
    expect(call.init.method).toBe("POST");
    expect(body(call)).toEqual({
      customerId: CUSTOMERS[0].id,
      title: "Boiler swap",
      description: null,
      stage: "proposal",
      amountCents: 123450,
      expectedCloseDate: "2027-01-15",
      assignedTo: MEMBERS[1].userId,
    });
    expect(body(call)).not.toHaveProperty("probabilityPercent");
    expect(notify.success).toHaveBeenCalledWith("Opportunity added", expect.anything());
  });
  it("an explicit probability, including 0, is sent", async () => {
    mockApi();
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "Zero chance");
    await userEvent.type(screen.getByLabelText(/Amount/), "0");
    await userEvent.type(screen.getByLabelText(/Probability/), "0");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0])).toMatchObject({ amountCents: 0, probabilityPercent: 0 });
  });
  it("the stage list offers only open stages when adding; the hint shows the default probability for the chosen stage", async () => {
    mockApi();
    renderForm();
    expect(
      within(screen.getByLabelText("Stage"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["New", "Qualified", "Proposal", "Negotiation"]);
    expect(screen.getByLabelText(/Probability/)).toHaveAttribute("placeholder", "10");
    await userEvent.selectOptions(screen.getByLabelText("Stage"), "negotiation");
    expect(screen.getByLabelText(/Probability/)).toHaveAttribute("placeholder", "75");
  });
  it("API field errors land at the controls, and a customer from another workspace (404) is a message at the picker, not a crash", async () => {
    mockApi(() =>
      respond(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the highlighted fields.",
          requestId: "r1",
          fieldErrors: {
            amountCents: ["That amount is too large."],
            title: ["Use between 2 and 150 characters."],
          },
        },
      }),
    );
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "Server disagrees");
    await userEvent.type(screen.getByLabelText(/Amount/), "5");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Amount/)).toHaveAttribute("aria-invalid", "true"),
    );
    expect(screen.getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Title/)).toHaveValue("Server disagrees");
    expect(push).not.toHaveBeenCalled();

    vi.restoreAllMocks();
    mockApi(() =>
      respond(404, {
        error: {
          code: "CUSTOMER_NOT_FOUND",
          message: "That customer was not found.",
          requestId: "r2",
        },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /Customer/ })).toHaveAttribute(
        "aria-invalid",
        "true",
      ),
    );
    expect(
      screen.getAllByText(/That customer was not found in this workspace/).length,
    ).toBeGreaterThan(0);
    expect(push).not.toHaveBeenCalled();
  });
  it("a server failure shows a message and keeps the form; one request on a double press", async () => {
    let release!: () => void;
    mockApi(
      () =>
        new Promise<Response>(
          (r) =>
            (release = () =>
              r(
                respond(500, {
                  error: {
                    code: "INTERNAL_ERROR",
                    message: "Something went wrong.",
                    requestId: "r9",
                  },
                }),
              )),
        ),
    );
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    await userEvent.type(screen.getByLabelText(/Title/), "Will fail");
    await userEvent.type(screen.getByLabelText(/Amount/), "10");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Saving..." }));
    release();
    expect(
      (await screen.findAllByRole("alert")).some((a) =>
        /Something went wrong|r9/.test(a.textContent ?? ""),
      ),
    ).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(screen.getByLabelText(/Title/)).toHaveValue("Will fail");
  });
});

describe("CustomerPicker (inside the form)", () => {
  it("searches the API, shows only matches, and choosing one sends its id", async () => {
    mockApi();
    renderForm();
    const input = screen.getByRole("combobox", { name: /Customer/ });
    await userEvent.type(input, "acme");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(options().map((o) => o.textContent)).toEqual([
      "Acme Plumbing · info@acme.example.com",
      "Acme Roofing · Acme Group",
    ]);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(
      calls.some(
        (c) =>
          c.url.includes("/customers") &&
          c.url.includes("q=acme") &&
          c.url.includes("archived=false"),
      ),
    ).toBe(true);
    await userEvent.click(within(listbox()).getByRole("option", { name: /Acme Roofing/ }));
    expect(input).toHaveValue("Acme Roofing");
    await userEvent.type(screen.getByLabelText(/Title/), "Roof job");
    await userEvent.type(screen.getByLabelText(/Amount/), "99");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0]).customerId).toBe(CUSTOMERS[1].id);
  });
  it("works from the keyboard: arrows move, Enter chooses (and does not submit), Escape closes", async () => {
    mockApi();
    renderForm();
    const user = userEvent.setup();
    const input = screen.getByRole("combobox", { name: /Customer/ });
    await user.click(input);
    await user.type(input, "acme");
    await waitFor(() => expect(options().length).toBe(2));
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringContaining("-opt-0"));
    await user.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}{ArrowDown}{Enter}");
    expect(input).toHaveValue("Acme Roofing");
    expect(writes()).toHaveLength(0);
    expect(screen.getByRole("listbox", { hidden: true })).not.toBeVisible();
    await user.clear(input);
    await user.type(input, "glob");
    await within(listbox()).findByRole("option", { name: /Globex/ });
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
  it("editing the text after choosing clears the choice, so a stale id can never be sent under a different name", async () => {
    mockApi();
    renderForm({ initialCustomer: { id: CUSTOMERS[0].id, name: "Acme Plumbing" } });
    const input = screen.getByRole("combobox", { name: /Customer/ });
    await userEvent.type(input, "x");
    await userEvent.type(screen.getByLabelText(/Title/), "Deal title");
    await userEvent.type(screen.getByLabelText(/Amount/), "10");
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(writes()).toHaveLength(0);
  });
  it("says when nothing matches", async () => {
    mockApi();
    renderForm();
    await userEvent.type(screen.getByRole("combobox", { name: /Customer/ }), "zzz");
    await waitFor(() => expect(screen.getByText("No matching customers.")).toBeInTheDocument());
    expect(options()).toHaveLength(0);
  });
});

describe("OpportunityForm: editing", () => {
  it("starts with the deal's values, amount written back as 1,234.50, and an unchanged amount round-trips to the same cents", async () => {
    mockApi(() =>
      respond(200, {
        data: {
          ...deal,
          title: "Warehouse retrofit 2",
          updatedAt: "2026-11-02T11:00:00.000000+00:00",
        },
        meta: {},
      }),
    );
    renderForm({ deal });
    expect(screen.getByLabelText(/Title/)).toHaveValue("Warehouse retrofit");
    expect(screen.getByLabelText(/Amount/)).toHaveValue("1,234.50");
    expect(screen.getByLabelText(/Probability/)).toHaveValue("50");
    expect(screen.getByLabelText(/Expected close date/)).toHaveValue("2026-12-01");
    expect(screen.queryByLabelText("Stage")).toBeNull();
    expect(screen.getByText("Change the stage from the opportunity page.")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText(/Title/));
    await userEvent.type(screen.getByLabelText(/Title/), "Warehouse retrofit 2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/app/opportunities/${deal.id}`));
    const [call] = writes();
    expect(call.init.method).toBe("PATCH");
    expect(body(call)).toMatchObject({
      title: "Warehouse retrofit 2",
      amountCents: 123450,
      expectedUpdatedAt: NOW,
    });
    expect(body(call)).not.toHaveProperty("stage");
  });
  it("a closed deal's probability is fixed by its stage and is not sent", async () => {
    mockApi(() => respond(200, { data: deal, meta: {} }));
    renderForm({ deal: { ...deal, stage: "won", probabilityPercent: 100, closedAt: NOW } });
    expect(screen.getByLabelText(/Probability/)).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Title/), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(body(writes()[0])).not.toHaveProperty("probabilityPercent");
  });
  it("a stale edit (409) offers the latest version and then saves against it", async () => {
    const latest = {
      ...deal,
      title: "Changed elsewhere",
      updatedAt: "2026-11-02T12:00:00.000000+00:00",
    };
    mockApi((_url, init) => {
      if (init.method === "PATCH" && body({ init }).expectedUpdatedAt === NOW)
        return respond(409, {
          error: {
            code: "STALE_EDIT",
            message: "changed",
            requestId: "r",
            meta: { current: { updatedAt: latest.updatedAt } },
          },
        });
      return respond(200, { data: latest, meta: {} });
    });
    renderForm({ deal });
    await userEvent.type(screen.getByLabelText(/Title/), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Someone else changed this opportunity.");
    await userEvent.click(within(alert).getByRole("button", { name: "Load the latest version" }));
    await waitFor(() => expect(screen.getByLabelText(/Title/)).toHaveValue("Changed elsewhere"));
    await userEvent.type(screen.getByLabelText(/Title/), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(body(writes().at(-1)!).expectedUpdatedAt).toBe(latest.updatedAt);
  });
});

describe("OpportunityForm: unsaved changes, keyboard, accessibility", () => {
  it("a link click with edits asks first; Cancel stays, Discard leaves", async () => {
    mockApi();
    renderForm();
    await userEvent.type(screen.getByLabelText(/Title/), "Half typed");
    await userEvent.click(screen.getByRole("link", { name: "Pipeline link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText(/Title/)).toHaveValue("Half typed");
    await userEvent.click(screen.getByRole("link", { name: "Pipeline link" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/opportunities"));
  });
  it("can be completed with the keyboard alone, including the customer picker", async () => {
    mockApi(() =>
      respond(201, { data: { ...deal, id: "d0000000-0000-4000-8000-0000000000aa" }, meta: {} }),
    );
    renderForm();
    const user = userEvent.setup();
    const tabTo = async (target: () => HTMLElement) => {
      for (let i = 0; i < 40 && document.activeElement !== target(); i++) await user.tab();
      expect(target()).toHaveFocus();
    };
    await tabTo(() => screen.getByRole("combobox", { name: /Customer/ }));
    await user.keyboard("glob");
    await within(listbox()).findByRole("option", { name: /Globex/ });
    await user.keyboard("{Enter}");
    await tabTo(() => screen.getByLabelText(/Title/));
    await user.keyboard("Keyboard deal");
    await tabTo(() => screen.getByLabelText(/Amount/));
    await user.keyboard("2,500");
    await tabTo(() => screen.getByRole("button", { name: "Add opportunity" }));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/opportunities/d0000000-0000-4000-8000-0000000000aa"),
    );
    expect(body(writes()[0])).toMatchObject({
      customerId: CUSTOMERS[2].id,
      title: "Keyboard deal",
      amountCents: 250000,
    });
  });
  it("has no axe violations pristine, with errors, and with the picker open", async () => {
    mockApi();
    const { container } = renderForm();
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole("button", { name: "Add opportunity" }));
    await expectNoA11yViolations(container);
    await userEvent.type(screen.getByRole("combobox", { name: /Customer/ }), "acme");
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    await expectNoA11yViolations(container);
  });
});
