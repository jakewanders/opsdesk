import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectNoA11yViolations } from "@/test/axe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DemoEntry, type DemoEntryDeps, type DemoStepResult } from "./demo-entry";

// The widget is Cloudflare's; here it is a stub that hands the flow tokens and errors on demand.
type Field = { onToken?: (t: string) => void; onError?: () => void; resetKey: number };
let field: Field = { resetKey: 0 };
vi.mock("@/components/auth/turnstile-field", () => ({
  TurnstileField: (props: Field) => {
    field = props;
    return <div data-testid="widget" data-reset={props.resetKey} />;
  },
}));

const ok: DemoStepResult = { ok: true };
function deps(over: Partial<DemoEntryDeps> = {}) {
  return {
    hasSession: vi.fn(over.hasSession ?? (async () => false)),
    signIn: vi.fn(over.signIn ?? (async (): Promise<DemoStepResult> => ok)),
    bootstrap: vi.fn(over.bootstrap ?? (async (): Promise<DemoStepResult> => ok)),
    navigate: vi.fn(over.navigate ?? (() => undefined)),
  };
}
const renderEntry = (d: DemoEntryDeps, repoUrl?: string) =>
  render(<DemoEntry siteKey="k" repoUrl={repoUrl} deps={d} />);
const token = (t = "tok-1") => act(async () => field.onToken?.(t));

beforeEach(() => {
  field = { resetKey: 0 };
});

describe("DemoEntry", () => {
  it("waits for the security check, then signs in, bootstraps once and opens the app", async () => {
    const d = deps();
    renderEntry(d);
    expect(screen.getByText(/quick security check/i)).toBeInTheDocument();
    expect(d.signIn).not.toHaveBeenCalled();
    await token();
    await waitFor(() => expect(d.navigate).toHaveBeenCalledWith("/app"));
    expect(d.signIn).toHaveBeenCalledWith("tok-1");
    expect(d.bootstrap).toHaveBeenCalledTimes(1);
    expect(d.bootstrap.mock.calls[0][0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("shows 'Preparing your demo workspace' while the work runs", async () => {
    let release!: () => void;
    const d = deps({
      bootstrap: () => new Promise<DemoStepResult>((r) => (release = () => r(ok))),
    });
    renderEntry(d);
    await token();
    expect(await screen.findByText("Preparing your demo workspace")).toBeInTheDocument();
    release();
    await waitFor(() => expect(d.navigate).toHaveBeenCalled());
  });

  it("ignores repeated tokens while it is working (no double sign-in)", async () => {
    let release!: () => void;
    const d = deps({
      bootstrap: () => new Promise<DemoStepResult>((r) => (release = () => r(ok))),
    });
    renderEntry(d);
    await token("a");
    await token("b");
    await token("c");
    release();
    await waitFor(() => expect(d.navigate).toHaveBeenCalledTimes(1));
    expect(d.signIn).toHaveBeenCalledTimes(1);
    expect(d.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing guest session instead of signing in again", async () => {
    const d = deps({ hasSession: async () => true });
    renderEntry(d);
    await token();
    await waitFor(() => expect(d.navigate).toHaveBeenCalled());
    expect(d.signIn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "captcha failure",
      {
        signIn: async (): Promise<DemoStepResult> => ({
          ok: false,
          status: 400,
          code: "captcha_failed",
        }),
      },
      /could not confirm you are a person/i,
    ],
    [
      "rate limit at sign-in",
      {
        signIn: async (): Promise<DemoStepResult> => ({
          ok: false,
          status: 429,
          code: "over_request_rate_limit",
        }),
      },
      /busy right now/i,
    ],
    [
      "backend down at sign-in",
      { signIn: async (): Promise<DemoStepResult> => ({ ok: false, network: true }) },
      /unavailable right now/i,
    ],
    [
      "capacity at bootstrap",
      {
        bootstrap: async (): Promise<DemoStepResult> => ({
          ok: false,
          status: 429,
          code: "DEMO_CAPACITY",
        }),
      },
      /busy right now/i,
    ],
    [
      "server error at bootstrap",
      {
        bootstrap: async (): Promise<DemoStepResult> => ({
          ok: false,
          status: 500,
          requestId: "req-9",
        }),
      },
      /unavailable right now/i,
    ],
    [
      "setup error",
      {
        bootstrap: async (): Promise<DemoStepResult> => ({
          ok: false,
          status: 422,
          code: "VALIDATION_ERROR",
        }),
      },
      /could not set up your demo/i,
    ],
  ])("%s: a named, retryable error, never success, never navigation", async (_n, over, title) => {
    const d = deps(over);
    renderEntry(d, "https://github.com/example/opsdesk");
    await token();
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/example/opsdesk",
    );
    expect(d.navigate).not.toHaveBeenCalled();
    expect(screen.queryByText("Preparing your demo workspace")).not.toBeInTheDocument();
  });

  it("asks the widget for a new token after a failure (a token works once)", async () => {
    const d = deps({ signIn: async () => ({ ok: false, status: 400, code: "captcha_failed" }) });
    renderEntry(d);
    await token();
    await screen.findByRole("alert");
    expect(screen.getByTestId("widget").dataset.reset).toBe("1");
  });

  it("retry after a failed bootstrap reuses the session and the same idempotency key", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const d = deps({
      hasSession: vi.fn(async () => calls > 0),
      bootstrap: vi.fn(async (): Promise<DemoStepResult> =>
        ++calls === 1 ? { ok: false, status: 500 } : ok,
      ),
    });
    renderEntry(d);
    await token();
    await screen.findByRole("alert");
    await token("tok-2"); // the reset widget issued a new token
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(d.navigate).toHaveBeenCalledWith("/app"));
    expect(d.bootstrap.mock.calls[1][0]).toBe(d.bootstrap.mock.calls[0][0]);
    expect(d.signIn).toHaveBeenCalledTimes(1);
  });

  it("a failed security check widget shows the retryable captcha error and creates no account", async () => {
    const d = deps();
    renderEntry(d);
    await act(async () => field.onError?.());
    expect(
      await screen.findByRole("heading", { name: /could not confirm you are a person/i }),
    ).toBeInTheDocument();
    expect(d.signIn).not.toHaveBeenCalled();
    expect(d.bootstrap).not.toHaveBeenCalled();
  });

  it("a signed-in member is told the demo is for guests, with a way to their workspace and no retry", async () => {
    const d = deps({ bootstrap: async () => ({ ok: false, status: 403, code: "GUEST_ONLY" }) });
    renderEntry(d);
    await token();
    expect(await screen.findByRole("heading", { name: "You are signed in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open my workspace" })).toHaveAttribute("href", "/app");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("has no accessibility violations while working and on an error", async () => {
    const d = deps({ bootstrap: async () => ({ ok: false, status: 500 }) });
    const { container } = renderEntry(d);
    await expectNoA11yViolations(container);
    await token();
    await screen.findByRole("alert");
    await expectNoA11yViolations(container);
  });
});
