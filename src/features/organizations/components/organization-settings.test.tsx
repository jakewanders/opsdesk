import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { expectNoA11yViolations } from "@/test/axe";
import type { OrganizationSettingsDto } from "../schema";
import { OrganizationSettings } from "./organization-settings";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  usePathname: () => "/app/settings/organization",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/actions", () => ({ logoutAction: vi.fn() }));

const SETTINGS: OrganizationSettingsDto = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Plumbing",
  industry: "Plumbing",
  timezone: "America/New_York",
  updatedAt: "2026-11-02T10:00:00.000000+00:00",
};
const ZONES = ["America/Chicago", "America/New_York", "Asia/Tokyo", "UTC"];

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let calls: Array<{ url: string; init: RequestInit }>;
function mockApi(handler: Handler) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    calls.push({ url: String(u), init: init ?? {} });
    return handler(String(u), init ?? {});
  });
}
const patches = () => calls.filter((c) => c.init.method === "PATCH");
const payload = (c: { init: RequestInit }) => JSON.parse(String(c.init.body));

const renderPage = (props: Partial<React.ComponentProps<typeof OrganizationSettings>> = {}) =>
  render(
    <ApiClientProvider organizationId="org-1">
      <OrganizationSettings
        settings={SETTINGS}
        memberRole="admin"
        isDemo={false}
        canEdit
        zones={ZONES}
        {...props}
      />
    </ApiClientProvider>,
  );

beforeEach(() => refresh.mockClear());
afterEach(() => vi.restoreAllMocks());

describe("OrganizationSettings: an owner or admin", () => {
  it("shows the role and an editable form with the current values", async () => {
    renderPage();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByLabelText(/Workspace name/)).toHaveValue("Acme Plumbing");
    expect(screen.getByLabelText(/Industry/)).toHaveValue("Plumbing");
    expect(screen.getByLabelText(/Time zone/)).toHaveValue("America/New_York");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });

  it("saves a rename and a new time zone with the version it last saw, then refreshes the app's data", async () => {
    mockApi(() =>
      respond(200, {
        data: {
          ...SETTINGS,
          name: "Acme Heating",
          timezone: "Asia/Tokyo",
          updatedAt: "2026-11-02T11:00:00.000000+00:00",
        },
        meta: {},
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.clear(screen.getByLabelText(/Workspace name/));
    await user.type(screen.getByLabelText(/Workspace name/), "Acme Heating");
    await user.selectOptions(screen.getByLabelText(/Time zone/), "Asia/Tokyo");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0].url).toContain(`/organizations/${SETTINGS.id}`);
    expect(payload(patches()[0])).toEqual({
      name: "Acme Heating",
      industry: "Plumbing",
      timezone: "Asia/Tokyo",
      expectedUpdatedAt: SETTINGS.updatedAt,
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // the next save uses the new version
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled(),
    );
  });

  it("sends a blank industry so it is cleared", async () => {
    mockApi(() => respond(200, { data: { ...SETTINGS, industry: null }, meta: {} }));
    const user = userEvent.setup();
    renderPage();
    await user.clear(screen.getByLabelText(/Industry/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(payload(patches()[0]).industry).toBeNull();
  });

  it("refuses a too-short name before calling the server, with the message next to the field", async () => {
    mockApi(() => respond(200, { data: SETTINGS, meta: {} }));
    const user = userEvent.setup();
    renderPage();
    await user.clear(screen.getByLabelText(/Workspace name/));
    await user.type(screen.getByLabelText(/Workspace name/), "A");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Workspace name/)).toHaveAttribute("aria-invalid", "true"),
    );
    const error = document.getElementById(
      screen
        .getByLabelText(/Workspace name/)
        .getAttribute("aria-describedby")!
        .split(" ")
        .pop()!,
    );
    expect(error?.textContent).toMatch(/Error:.*Use between 2 and 80 characters\./);
    expect(patches()).toHaveLength(0);
  });

  it("puts a server field error next to its field", async () => {
    mockApi(() =>
      respond(422, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Fix it",
          fieldErrors: { timezone: ["Choose a valid time zone, for example America/New_York."] },
          requestId: "r1",
        },
      }),
    );
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/Industry/), " and heating");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Time zone/)).toHaveAttribute("aria-invalid", "true"),
    );
    expect(document.body.textContent).toMatch(/Error:.*Choose a valid time zone/);
  });

  it("on a stale edit keeps the typing, says who won, and offers the latest version", async () => {
    mockApi((url, init) => {
      if (init.method === "PATCH")
        return respond(409, {
          error: {
            code: "STALE_EDIT",
            message: "changed",
            meta: { current: { updatedAt: "2026-11-02T12:00:00.000000+00:00" } },
            requestId: "r2",
          },
        });
      return respond(200, {
        data: {
          ...SETTINGS,
          name: "Renamed Elsewhere",
          updatedAt: "2026-11-02T12:00:00.000000+00:00",
        },
        meta: {},
      });
    });
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/Industry/), " x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Someone else changed these settings.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Industry/)).toHaveValue("Plumbing x");
    await user.click(screen.getByRole("button", { name: "Load the latest version" }));
    await waitFor(() =>
      expect(screen.getByLabelText(/Workspace name/)).toHaveValue("Renamed Elsewhere"),
    );
    expect(screen.queryByText("Someone else changed these settings.")).not.toBeInTheDocument();
  });

  it("explains a 403 in words", async () => {
    mockApi(() => respond(403, { error: { code: "FORBIDDEN", message: "no", requestId: "r3" } }));
    const user = userEvent.setup();
    renderPage();
    await user.type(screen.getByLabelText(/Industry/), "x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(
      await screen.findByText("Only owners and admins can change these settings."),
    ).toBeInTheDocument();
  });
});

describe("OrganizationSettings: read-only modes", () => {
  for (const role of ["member", "viewer"] as const) {
    it(`${role}: values as text, the reason, no inputs and no save button`, async () => {
      renderPage({ memberRole: role, canEdit: false });
      expect(screen.getByText(role === "member" ? "Member" : "Viewer")).toBeInTheDocument();
      expect(screen.getByText("Acme Plumbing")).toBeInTheDocument();
      expect(screen.getByText("Plumbing")).toBeInTheDocument();
      expect(screen.getByText("America/New York")).toBeInTheDocument();
      expect(
        screen.getByText(/Only owners and admins can change these settings/),
      ).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Reset Demo/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
    });
  }

  it("a missing industry reads as 'Not set'", () => {
    renderPage({ canEdit: false, settings: { ...SETTINGS, industry: null } });
    expect(screen.getByText("Not set")).toBeInTheDocument();
  });

  it("a demo guest: read-only with the reason, Reset Demo, and a sign-out that says what it ends", async () => {
    renderPage({ memberRole: "owner", isDemo: true, canEdit: false });
    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText(/A demo workspace cannot be renamed/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reset Demo/ })).toBeInTheDocument();
    expect(screen.getByText(/ends it for this browser/)).toBeInTheDocument();
    await expectNoA11yViolations(document.body);
  });
});
