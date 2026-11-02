import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import type { InvitationDto } from "../schema";
import type { MemberDto } from "../service";
import { MembersView } from "./members-view";

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("@/components/shared/toast", () => ({ notify }));

const ME = "00000000-0000-4000-8000-0000000000aa";
const JOINED = "2026-10-01T12:00:00.000000+00:00";
const member = (id: string, name: string, role: string): MemberDto => ({
  userId: id,
  displayName: name,
  role,
  joinedAt: JOINED,
});
const OWNER = member(ME, "Olive Owner", "owner");
const SAM = member("00000000-0000-4000-8000-0000000000bb", "Sam Member", "member");
const AMY = member("00000000-0000-4000-8000-0000000000cc", "Amy Admin", "admin");
const INVITE: InvitationDto = {
  id: "00000000-0000-4000-8000-0000000000dd",
  email: "new@example.test",
  role: "viewer",
  invitedBy: ME,
  createdAt: JOINED,
  expiresAt: "2026-12-01T12:00:00.000000+00:00",
  expired: false,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Array<{ method: string; path: string; body?: unknown }>;
let current: MemberDto[];
let respond: (method: string, path: string) => Response | null;

beforeEach(() => {
  calls = [];
  current = [OWNER, SAM, AMY];
  respond = () => null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const url = new URL(String(u), "http://localhost");
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const custom = respond(method, url.pathname);
    if (custom) return custom;
    if (url.pathname.endsWith("/members") && method === "GET")
      return json(200, { data: current, meta: {} });
    if (url.pathname.endsWith("/invitations") && method === "GET")
      return json(200, { data: [INVITE], meta: {} });
    return json(200, { data: [], meta: {} });
  });
});
afterEach(() => vi.restoreAllMocks());

function renderView(
  over: { members?: MemberDto[]; actorId?: string; actorRole?: string; canManage?: boolean } = {},
) {
  return render(
    <ApiClientProvider organizationId="org-1">
      <MembersView
        initialMembers={over.members ?? [OWNER, SAM, AMY]}
        actorId={over.actorId ?? ME}
        actorRole={over.actorRole ?? "owner"}
        canManage={over.canManage ?? true}
      />
    </ApiClientProvider>,
  );
}
const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

describe("MembersView", () => {
  it("shows name, role and joined date for everyone", () => {
    renderView({ actorRole: "viewer", canManage: false });
    const table = screen.getByRole("table", { name: "Members of this workspace" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Name", "Role", "Joined", "Actions"]);
    expect(within(row("Sam Member")).getByText("Member")).toBeInTheDocument();
    expect(within(row("Sam Member")).getByText("Oct 1, 2026")).toBeInTheDocument();
  });

  it("a viewer or member gets a read-only list: no invite button, no invitations, no actions", () => {
    renderView({ actorRole: "viewer", canManage: false });
    expect(screen.queryByRole("button", { name: /Invite someone/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Pending invitations" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Change role|Remove/ })).toBeNull();
    expect(screen.getAllByText("Read only")).toHaveLength(3);
    expect(calls.some((c) => c.path.endsWith("/invitations"))).toBe(false);
  });

  it("an admin has no controls on an owner, with the reason in words", () => {
    renderView({ actorId: AMY.userId, actorRole: "admin" });
    expect(within(row("Olive Owner")).queryByRole("button")).toBeNull();
    expect(
      within(row("Olive Owner")).getByText(/Only an owner can change or remove an owner/),
    ).toBeInTheDocument();
    expect(
      within(row("Sam Member")).getByRole("button", { name: /Change role ?for Sam Member/ }),
    ).toBeEnabled();
  });

  it("the only owner cannot be demoted or removed, and says why", () => {
    renderView({ members: [OWNER, SAM] });
    expect(within(row("Olive Owner")).queryByRole("button")).toBeNull();
    expect(within(row("Olive Owner")).getByText(/at least one owner/)).toBeInTheDocument();
  });

  it("an owner can invite: the one-time link is shown with a clear warning, and is gone after closing", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    respond = (method, path) =>
      method === "POST" && path.endsWith("/invitations")
        ? json(201, {
            data: {
              id: INVITE.id,
              email: "new@example.test",
              role: "viewer",
              expiresAt: INVITE.expiresAt,
              token: "a".repeat(64),
              link: `http://localhost/invite#token=${"a".repeat(64)}`,
            },
            meta: {},
          })
        : null;
    renderView();
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText(/Email address/), "new@example.test");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "viewer");
    await user.click(within(dialog).getByRole("button", { name: "Create invite link" }));

    const ready = await screen.findByRole("dialog", { name: "Invitation ready" });
    expect(
      within(ready).getByText("This link will not be shown again. Copy it now."),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      email: "new@example.test",
      role: "viewer",
    });
    await user.click(within(ready).getByRole("button", { name: "Copy invite link" }));
    expect(writeText).toHaveBeenCalledWith(`http://localhost/invite#token=${"a".repeat(64)}`);
    expect(await within(ready).findByText("Link copied.")).toBeInTheDocument();

    await user.click(within(ready).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    expect(screen.queryByDisplayValue(/invite#token/)).toBeNull();
  });

  it("an invalid address is explained and nothing is sent", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(screen.getByRole("button", { name: "Invite someone" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite someone" });
    await user.type(within(dialog).getByLabelText(/Email address/), "nope");
    await user.click(within(dialog).getByRole("button", { name: "Create invite link" }));
    expect(await within(dialog).findByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("an owner changes a role, and only assignable roles are offered", async () => {
    const user = userEvent.setup();
    renderView({ actorId: ME, actorRole: "owner" });
    await user.click(
      within(row("Sam Member")).getByRole("button", { name: /Change role ?for Sam Member/ }),
    );
    const dialog = await screen.findByRole("dialog", { name: /Change role ?for Sam Member/ });
    const options = within(within(dialog).getByLabelText("New role"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Owner", "Admin", "Viewer"]);
    await user.selectOptions(within(dialog).getByLabelText("New role"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Change role" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
      path: expect.stringContaining(`/members/${SAM.userId}`),
      body: { role: "admin" },
    });
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith("Role changed", "Sam Member is now admin."),
    );
  });

  it("a refusal from the server is shown in words (the last-owner rule)", async () => {
    const user = userEvent.setup();
    respond = (method) =>
      method === "PATCH"
        ? json(409, {
            error: {
              code: "LAST_OWNER",
              message: "An organization must keep at least one owner.",
              requestId: "req-1",
            },
          })
        : null;
    renderView();
    await user.click(
      within(row("Sam Member")).getByRole("button", { name: /Change role ?for Sam Member/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Change role" }));
    expect(
      await within(dialog).findByText("An organization must keep at least one owner."),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // still open: nothing changed
  });

  it("removal asks first, and the dialog focuses Cancel", async () => {
    const user = userEvent.setup();
    renderView();
    await user.click(within(row("Sam Member")).getByRole("button", { name: /Remove ?Sam Member/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove Sam Member?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.path).toContain(`/members/${SAM.userId}`),
    );
    await waitFor(() =>
      expect(notify.success).toHaveBeenCalledWith(
        "Member removed",
        "Sam Member no longer has access.",
      ),
    );
  });

  it("you cannot remove yourself", () => {
    renderView({ members: [OWNER, AMY, { ...SAM, role: "owner" }] });
    expect(within(row("Olive Owner")).queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(within(row("Olive Owner")).getByText(/cannot remove yourself/)).toBeInTheDocument();
  });

  it("lists pending invitations with expiry and revokes one after confirming", async () => {
    const user = userEvent.setup();
    renderView();
    const section = (await screen.findByRole("heading", { name: "Pending invitations" })).closest(
      "section",
    )!;
    expect(await within(section).findByText("new@example.test")).toBeInTheDocument();
    expect(within(section).getByText("Dec 1, 2026")).toBeInTheDocument();
    await user.click(
      within(section).getByRole("button", { name: /Revoke ?invitation for new@example.test/ }),
    );
    await user.click(await screen.findByRole("button", { name: "Revoke invitation" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "DELETE")?.path).toContain(`/invitations/${INVITE.id}`),
    );
  });

  it("an expired invitation says so in words", async () => {
    respond = (method, path) =>
      method === "GET" && path.endsWith("/invitations")
        ? json(200, { data: [{ ...INVITE, expired: true }], meta: {} })
        : null;
    renderView();
    const cell = (await screen.findByText(/^Expired/)).closest("td")!;
    expect(within(cell).getByText("Dec 1, 2026")).toBeInTheDocument();
  });
});
