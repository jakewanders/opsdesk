import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptInvite, type Viewer } from "./accept-invite";

const select = vi.hoisted(() => vi.fn());
vi.mock("@/lib/org/actions", () => ({ selectWorkspaceAction: select }));
vi.mock("@/lib/auth/actions", () => ({ logoutAction: vi.fn() }));

const T = "ab".repeat(32);
const ORG = "00000000-0000-4000-8000-000000000001";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const PREVIEW = {
  organizationName: "Acme Plumbing",
  role: "member",
  expiresAt: "2026-12-01T00:00:00Z",
  invitedEmailHint: "j***@example.test",
  emailVerified: true,
  emailMatches: true,
};
const refusal = (status: number, code: string) =>
  json(status, { error: { code, message: "x", requestId: "r1" } });

let calls: Array<{ path: string; body: unknown }>;
let handler: (path: string) => Response;
const member: Viewer = { kind: "member", email: "jo@example.test" };

beforeEach(() => {
  calls = [];
  select.mockReset();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/invite");
  handler = (path) =>
    path.endsWith("/preview")
      ? json(200, { data: PREVIEW, meta: {} })
      : json(200, { data: { organizationId: ORG, role: "member" }, meta: {} });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (u, init) => {
    const path = new URL(String(u), "http://localhost").pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return handler(path);
  });
});
afterEach(() => vi.restoreAllMocks());

const open = (hash = `#token=${T}`) => window.history.replaceState(null, "", `/invite${hash}`);

describe("AcceptInvite", () => {
  it("without a token it asks for the full link", async () => {
    render(<AcceptInvite viewer={member} />);
    expect(await screen.findByText("This page needs an invitation link")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it("removes the token from the address bar as soon as it has been read", async () => {
    open();
    render(<AcceptInvite viewer={member} />);
    await screen.findByRole("heading", { name: "Join Acme Plumbing" });
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(T);
  });

  it("a signed-in person sees the workspace, the role and which account they are using before joining", async () => {
    open();
    render(<AcceptInvite viewer={member} />);
    expect(await screen.findByRole("heading", { name: "Join Acme Plumbing" })).toBeInTheDocument();
    expect(screen.getByText(/as/, { selector: "p" })).toHaveTextContent("member");
    expect(screen.getByText("j***@example.test")).toBeInTheDocument();
    expect(screen.getByText("jo@example.test")).toBeInTheDocument();
    expect(calls).toEqual([{ path: "/api/v1/invitations/preview", body: { token: T } }]);
  });

  it("joining sends the token once and selects the new workspace explicitly", async () => {
    const user = userEvent.setup();
    open();
    render(<AcceptInvite viewer={member} />);
    await user.click(await screen.findByRole("button", { name: "Join Acme Plumbing" }));
    await waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    expect((select.mock.calls[0][0] as FormData).get("orgId")).toBe(ORG);
    expect(calls.map((c) => c.path)).toEqual([
      "/api/v1/invitations/preview",
      "/api/v1/invitations/accept",
    ]);
    expect(sessionStorage.length).toBe(0);
  });

  it("signed out: sign in or create an account, returning here, with the token parked for the trip", async () => {
    open();
    render(<AcceptInvite viewer={{ kind: "signed-out" }} />);
    const signIn = await screen.findByRole("link", { name: "Sign in" });
    expect(signIn).toHaveAttribute("href", "/login?next=%2Finvite");
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup?next=%2Finvite",
    );
    expect(sessionStorage.getItem("opsdesk.invite")).toBe(T);
    expect(window.location.hash).toBe("");
    expect(calls).toHaveLength(0); // nothing is looked up without an account
  });

  it("coming back from sign-in, the parked token is used once and then deleted", async () => {
    sessionStorage.setItem("opsdesk.invite", T);
    render(<AcceptInvite viewer={member} />);
    expect(await screen.findByRole("heading", { name: "Join Acme Plumbing" })).toBeInTheDocument();
    expect(calls[0].body).toEqual({ token: T });
    expect(sessionStorage.getItem("opsdesk.invite")).toBeNull();
  });

  it("a demo guest is told to create a real account first", async () => {
    open();
    render(<AcceptInvite viewer={{ kind: "guest" }} />);
    expect(
      await screen.findByRole("heading", { name: "Create an account to accept this invitation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an account" })).toHaveAttribute(
      "href",
      "/signup?next=%2Finvite",
    );
    expect(calls).toHaveLength(0);
  });

  it("the wrong account cannot join and is offered a way to switch", async () => {
    handler = () => json(200, { data: { ...PREVIEW, emailMatches: false }, meta: {} });
    open();
    render(<AcceptInvite viewer={member} />);
    expect(
      await screen.findByText("This invitation is for a different email address"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join Acme Plumbing" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sign out and use another account" }),
    ).toBeInTheDocument();
  });

  it("an unconfirmed address cannot join and is told to confirm it", async () => {
    handler = () => json(200, { data: { ...PREVIEW, emailVerified: false }, meta: {} });
    open();
    render(<AcceptInvite viewer={member} />);
    expect(await screen.findByText("Confirm your email address first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Join Acme Plumbing" })).toBeDisabled();
  });

  it.each([
    [404, "INVITATION_INVALID", "This invitation link is not valid"],
    [409, "INVITATION_REVOKED", "This invitation was withdrawn"],
    [409, "INVITATION_USED", "This invitation was already used"],
    [409, "INVITATION_EXPIRED", "This invitation has expired"],
    [429, "RATE_LIMITED", "Too many attempts"],
  ])(
    "a refused preview (%i %s) explains what happened and what to do",
    async (status, code, title) => {
      handler = () => refusal(status, code);
      open();
      render(<AcceptInvite viewer={member} />);
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Join/ })).toBeNull();
    },
  );

  it("a refusal at the moment of joining is explained too (a link used in another tab)", async () => {
    handler = (path) =>
      path.endsWith("/preview")
        ? json(200, { data: PREVIEW, meta: {} })
        : refusal(409, "INVITATION_USED");
    const user = userEvent.setup();
    open();
    render(<AcceptInvite viewer={member} />);
    await user.click(await screen.findByRole("button", { name: "Join Acme Plumbing" }));
    expect(
      await screen.findByRole("heading", { name: "This invitation was already used" }),
    ).toBeInTheDocument();
    expect(select).not.toHaveBeenCalled();
  });
});
