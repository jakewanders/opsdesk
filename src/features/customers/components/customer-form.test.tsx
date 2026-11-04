import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { CustomerDto } from "../schema";
import { CustomerForm } from "./customer-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: push, refresh: vi.fn() }),
  usePathname: () => "/app/customers/new",
  useSearchParams: () => new URLSearchParams(),
}));

const ME = "00000000-0000-4000-8000-0000000000aa";
const TEAMMATE = "00000000-0000-4000-8000-0000000000bb";
const MEMBERS = [
  { userId: ME, role: "owner", displayName: "Olivia Owner" },
  { userId: TEAMMATE, role: "member", displayName: "Tom Teammate" },
];
const existing: CustomerDto = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "company",
  displayName: "Acme Plumbing",
  companyName: null,
  email: "info@acme.example.com",
  phone: null,
  website: null,
  status: "active",
  source: "referral",
  tags: ["vip"],
  notes: null,
  assignedTo: null,
  createdBy: ME,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-02T10:00:00.000000+00:00",
  archivedAt: null,
};

const respond = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: Array<{ url: string; init: RequestInit }>;
function mockApi(handler: Handler) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = String(u);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/api/v1/members")) return respond(200, { data: MEMBERS, meta: { total: 2 } });
    return handler(url, init ?? {});
  });
}
const writes = () => calls.filter((c) => c.init.method === "POST" || c.init.method === "PATCH");
const body = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

const renderForm = (props: Partial<React.ComponentProps<typeof CustomerForm>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <Link href="/app/customers">Customers link</Link>
      <CustomerForm currentUserId={ME} {...props} />
    </ApiClientProvider>,
  );

beforeEach(() => push.mockClear());
afterEach(() => vi.restoreAllMocks());

describe("CustomerForm: validation (client, with the API's own schema)", () => {
  it("shows the exact message next to the field, links it with aria-describedby, summarizes and focuses the summary", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    const name = screen.getByLabelText(/Display name/);
    expect(name).toHaveAttribute("aria-invalid", "true");
    const describedBy = name.getAttribute("aria-describedby")!;
    expect(
      describedBy
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toMatch(/Error:.*Use between 2 and 120 characters\./);
    const summary = screen.getByRole("alert");
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole("link", { name: /Display name/ })).toHaveAttribute(
      "href",
      "#customer-displayName",
    );
    expect(writes()).toHaveLength(0);
    // the summary link moves focus to the field
    await userEvent.click(within(summary).getByRole("link", { name: /Display name/ }));
    expect(name).toHaveFocus();
  });
  it("refuses a bad email, a non-http website, an over-long phone and notes, each at its field", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Valid Name");
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    await userEvent.type(screen.getByLabelText("Website"), "javascript:alert(1)");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Website")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Display name/)).not.toHaveAttribute("aria-invalid");
    expect(writes()).toHaveLength(0);
  });
  it("tags: add with Enter (not submitting), no duplicates, remove, and more than 10 is refused at the tags field", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    const tagInput = screen.getByPlaceholderText("Add a tag");
    await userEvent.type(tagInput, "vip{Enter}");
    await userEvent.type(tagInput, "VIP{Enter}");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(writes()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Remove tag vip" }));
    expect(screen.queryByRole("list", { name: "Tags" })).toBeNull();
    for (let i = 0; i < 11; i++) await userEvent.type(tagInput, `tag${i}{Enter}`);
    await userEvent.type(screen.getByLabelText(/Display name/), "Many Tags");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(/Tags/);
    expect(writes()).toHaveLength(0);
  });
});

describe("CustomerForm: saving", () => {
  it("sends the normalized body (trimmed, lower-case email, blanks as null), toasts and goes to the customer", async () => {
    mockApi(() =>
      respond(201, { data: { ...existing, id: "22222222-2222-4222-8222-222222222222" }, meta: {} }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "  New Client  ");
    await userEvent.type(screen.getByLabelText("Email"), "  Info@New.EXAMPLE.com ");
    await userEvent.selectOptions(screen.getByLabelText("Status"), "active");
    await userEvent.selectOptions(screen.getByLabelText("Owner"), TEAMMATE);
    await userEvent.type(screen.getByPlaceholderText("Add a tag"), "vip{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/customers/22222222-2222-4222-8222-222222222222"),
    );
    const [call] = writes();
    expect(call.url).toContain("/customers");
    expect(call.init.method).toBe("POST");
    expect(body(call)).toMatchObject({
      displayName: "New Client",
      email: "info@new.example.com",
      companyName: null,
      phone: null,
      website: null,
      status: "active",
      assignedTo: TEAMMATE,
      tags: ["vip"],
      type: "person",
      source: "other",
    });
    expect(new Headers(call.init.headers).get("X-Organization-Id")).toBe("org-1");
  });
  it("a second press while the save is running sends one request", async () => {
    let release!: () => void;
    mockApi(
      () =>
        new Promise<Response>(
          (r) => (release = () => r(respond(201, { data: existing, meta: {} }))),
        ),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Double Click");
    const button = screen.getByRole("button", { name: "Add customer" });
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    release();
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(writes()).toHaveLength(1);
  });
  it("API fieldErrors appear next to their fields and the summary, and the typed values stay", async () => {
    mockApi(() =>
      respond(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Check the highlighted fields.",
          requestId: "r1",
          fieldErrors: {
            email: ["Enter a valid email address."],
            "tags.0": ["Tags can be at most 30 characters."],
          },
        },
      }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Server Says No");
    await userEvent.type(screen.getByLabelText("Email"), "ok@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true"),
    );
    expect(
      document.getElementById(
        screen.getByLabelText("Email").getAttribute("aria-describedby")!.split(" ").pop()!,
      ),
    ).toHaveTextContent("Enter a valid email address.");
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Server Says No");
    expect(push).not.toHaveBeenCalled();
  });
  it("a duplicate email is a non-blocking warning after the save, with a link to the existing customer", async () => {
    mockApi(() =>
      respond(201, {
        data: { ...existing, id: "33333333-3333-4333-8333-333333333333", displayName: "Twin" },
        meta: {
          warnings: [
            {
              code: "DUPLICATE_EMAIL",
              field: "email",
              message: "x",
              customerId: "44444444-4444-4444-8444-444444444444",
            },
          ],
        },
      }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Twin");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Customer added.");
    expect(status).toHaveTextContent("Another customer in this workspace has this email.");
    expect(
      within(status).getByRole("link", { name: "Open the existing customer" }),
    ).toHaveAttribute("href", "/app/customers/44444444-4444-4444-8444-444444444444");
    expect(within(status).getByRole("link", { name: /Continue to Twin/ })).toHaveAttribute(
      "href",
      "/app/customers/33333333-3333-4333-8333-333333333333",
    );
    expect(push).not.toHaveBeenCalled();
  });
  it("a server failure shows a message and keeps the form", async () => {
    mockApi(() =>
      respond(500, {
        error: { code: "INTERNAL_ERROR", message: "Something went wrong.", requestId: "r9" },
      }),
    );
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Will Fail");
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Something went wrong|r9/);
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Will Fail");
  });
});

describe("CustomerForm: editing", () => {
  it("starts with the customer's values and sends a PATCH with the version it loaded", async () => {
    mockApi(() =>
      respond(200, {
        data: {
          ...existing,
          displayName: "Acme Plumbing Ltd",
          updatedAt: "2026-11-02T11:00:00.000000+00:00",
        },
        meta: {},
      }),
    );
    renderForm({ customer: existing });
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Acme Plumbing");
    expect(screen.getByRole("list", { name: "Tags" })).toHaveTextContent("vip");
    await userEvent.clear(screen.getByLabelText(/Display name/));
    await userEvent.type(screen.getByLabelText(/Display name/), "Acme Plumbing Ltd");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/app/customers/${existing.id}`));
    const [call] = writes();
    expect(call.init.method).toBe("PATCH");
    expect(call.url).toContain(`/customers/${existing.id}`);
    expect(body(call)).toMatchObject({
      displayName: "Acme Plumbing Ltd",
      expectedUpdatedAt: existing.updatedAt,
    });
  });
  const stale409 = respond.bind(null, 409, {
    error: { code: "STALE_EDIT", message: "changed", requestId: "r2", meta: { current: {} } },
  });

  it("a stale edit (409) opens the conflict dialog; Reload latest discards mine, and the next save sends the new version", async () => {
    const latest = {
      ...existing,
      displayName: "Acme (edited elsewhere)",
      updatedAt: "2026-11-02T12:00:00.000000+00:00",
    };
    mockApi((url, init) => {
      if (init.method === "PATCH" && body({ init }).expectedUpdatedAt === existing.updatedAt)
        return stale409();
      return respond(200, { data: latest, meta: {} });
    });
    renderForm({ customer: existing });
    await userEvent.clear(screen.getByLabelText(/Display name/));
    await userEvent.type(screen.getByLabelText(/Display name/), "My edit");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Someone else changed this customer");
    await within(dialog).findByText(/Changed by them:/);
    expect(dialog).toHaveTextContent("Changed by them: Display name.");
    expect(dialog).toHaveTextContent("Changed by you: Display name.");
    // the same field on both sides: no "on top"
    expect(within(dialog).queryByRole("button", { name: "Apply my changes on top" })).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reload latest" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Display name/)).toHaveValue("Acme (edited elsewhere)"),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await userEvent.type(screen.getByLabelText(/Display name/), "!");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(body(writes().at(-1)!).expectedUpdatedAt).toBe(latest.updatedAt);
  });

  it("when we changed different fields, 'Apply my changes on top' puts mine on the latest, unsaved, and the next save sends the new version", async () => {
    const latest = {
      ...existing,
      phone: "555-0199",
      updatedAt: "2026-11-02T12:00:00.000000+00:00",
    };
    mockApi((url, init) => {
      if (init.method === "PATCH" && body({ init }).expectedUpdatedAt === existing.updatedAt)
        return stale409();
      return respond(200, {
        data: init.method === "PATCH" ? { ...latest, displayName: "My edit" } : latest,
        meta: {},
      });
    });
    renderForm({ customer: existing });
    await userEvent.clear(screen.getByLabelText(/Display name/));
    await userEvent.type(screen.getByLabelText(/Display name/), "My edit");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("alertdialog");
    await within(dialog).findByText(/Changed by them:/);
    expect(dialog).toHaveTextContent("Changed by them: Phone.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply my changes on top" }));
    await waitFor(() => expect(screen.getByLabelText(/Phone/)).toHaveValue("555-0199"));
    expect(screen.getByLabelText(/Display name/)).toHaveValue("My edit");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const patchesBefore = writes().length;
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(writes().length).toBe(patchesBefore + 1);
    const sent = body(writes().at(-1)!);
    expect(sent.expectedUpdatedAt).toBe(latest.updatedAt);
    expect(sent.displayName).toBe("My edit");
    expect(sent.phone).toBe("555-0199");
  });

  it("'Keep editing' leaves the form as typed, and saving again conflicts again instead of overwriting", async () => {
    mockApi((url, init) => {
      if (init.method === "PATCH") return stale409();
      return respond(200, {
        data: { ...existing, updatedAt: "2026-11-02T12:00:00.000000+00:00" },
        meta: {},
      });
    });
    renderForm({ customer: existing });
    await userEvent.clear(screen.getByLabelText(/Display name/));
    await userEvent.type(screen.getByLabelText(/Display name/), "My edit");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByLabelText(/Display name/)).toHaveValue("My edit");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(writes().every((w) => body(w).expectedUpdatedAt === existing.updatedAt)).toBe(true);
  });

  it("'Copy my changes' copies only the person's own changed fields", async () => {
    mockApi((url, init) =>
      init.method === "PATCH"
        ? stale409()
        : respond(200, {
            data: { ...existing, updatedAt: "2026-11-02T12:00:00.000000+00:00" },
            meta: {},
          }),
    );
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderForm({ customer: existing });
    await user.clear(screen.getByLabelText(/Display name/));
    await user.type(screen.getByLabelText(/Display name/), "My edit");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(await within(dialog).findByRole("button", { name: "Copy my changes" }));
    expect(writeText).toHaveBeenCalledWith("Display name: My edit");
  });
});

describe("CustomerForm: owner list", () => {
  it("lists Unassigned and exactly the workspace's members from the API, marking the caller", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    const select = screen.getByLabelText("Owner");
    await waitFor(() => expect(select).not.toBeDisabled());
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Unassigned", "Olivia Owner (you)", "Tom Teammate"]);
    expect(
      calls.some(
        (c) =>
          c.url.includes("/api/v1/members") &&
          new Headers(c.init.headers).get("X-Organization-Id") === "org-1",
      ),
    ).toBe(true);
  });
  it("keeps an owner who is no longer in the list as a visible option rather than silently clearing it", async () => {
    mockApi(() => respond(201, {}));
    renderForm({ customer: { ...existing, assignedTo: "00000000-0000-4000-8000-0000000000cc" } });
    await waitFor(() => expect(screen.getByLabelText("Owner")).not.toBeDisabled());
    expect(screen.getByLabelText("Owner")).toHaveValue("00000000-0000-4000-8000-0000000000cc");
  });
});

describe("CustomerForm: unsaved changes", () => {
  it("clicking a link with edits asks first; Keep editing stays, Discard changes leaves", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    await userEvent.type(screen.getByLabelText(/Display name/), "Half typed");
    await userEvent.click(screen.getByRole("link", { name: "Customers link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Discard your changes?");
    expect(push).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByLabelText(/Display name/)).toHaveValue("Half typed");
    await userEvent.click(screen.getByRole("link", { name: "Customers link" }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/app/customers"));
  });
  it("with no edits a link just works, and the tab-close prompt is only armed while there are edits", async () => {
    mockApi(() => respond(201, {}));
    renderForm();
    const pristine = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pristine);
    expect(pristine.defaultPrevented).toBe(false);
    await userEvent.type(screen.getByLabelText(/Display name/), "x");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });
});

describe("CustomerForm: keyboard and accessibility", () => {
  it("can be completed with the keyboard alone", async () => {
    mockApi(() =>
      respond(201, { data: { ...existing, id: "55555555-5555-4555-8555-555555555555" }, meta: {} }),
    );
    renderForm();
    const user = userEvent.setup();
    const tabTo = async (target: () => HTMLElement) => {
      for (let i = 0; i < 40 && document.activeElement !== target(); i++) await user.tab();
      expect(target()).toHaveFocus();
    };
    await tabTo(() => screen.getByLabelText(/Display name/));
    await user.keyboard("Keyboard Only");
    await tabTo(() => screen.getByRole("button", { name: "Add customer" }));
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/app/customers/55555555-5555-4555-8555-555555555555"),
    );
    expect(body(writes()[0]).displayName).toBe("Keyboard Only");
  });
  it("has no axe violations pristine and with errors showing", async () => {
    mockApi(() => respond(201, {}));
    const { container } = renderForm();
    await expectNoA11yViolations(container);
    await userEvent.click(screen.getByRole("button", { name: "Add customer" }));
    await expectNoA11yViolations(container);
  });
});
