import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthFormState } from "@/lib/auth/form-state";
import { expectNoA11yViolations } from "@/test/axe";
import { AuthForm } from "./auth-form";

// The real widget loads a script from Cloudflare; here it is just the token field it renders.
vi.mock("./turnstile-field", () => ({
  TurnstileField: ({ error }: { error?: string }) => (
    <div>
      <input type="hidden" name="captchaToken" value="test-token" />
      {error ? <p>{error}</p> : null}
    </div>
  ),
}));

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;

const failure = (extra: Partial<AuthFormState>): Action =>
  vi.fn(async (previous) => ({
    status: "error" as const,
    attempt: previous.attempt + 1,
    ...extra,
  }));

describe("AuthForm", () => {
  it("renders labelled, required email and password fields and a submit button", () => {
    render(<AuthForm mode="login" action={failure({})} siteKey="k" />);
    expect(screen.getByRole("textbox", { name: /Email/ })).toBeRequired();
    expect(screen.getByLabelText(/Password/)).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("login links to forgot-password; signup links to terms and privacy", () => {
    const { unmount } = render(<AuthForm mode="login" action={failure({})} siteKey="k" />);
    expect(screen.getByRole("link", { name: "Forgot your password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    unmount();
    render(<AuthForm mode="signup" action={failure({})} siteKey="k" />);
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "Privacy notice" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/)).toHaveAttribute("autocomplete", "new-password");
  });

  it("shows field errors, links them in a summary, and focuses the summary", async () => {
    const user = userEvent.setup();
    const action = failure({
      fieldErrors: { email: ["Enter your email address."], password: ["Enter your password."] },
    });
    render(<AuthForm mode="login" action={action} siteKey="k" />);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole("link", { name: "Enter your email address." })).toHaveAttribute(
      "href",
      "#email",
    );
    expect(screen.getByRole("textbox", { name: /Email/ })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText(/Password/)).toHaveAttribute("aria-invalid", "true");
    await user.click(screen.getByRole("link", { name: "Enter your password." }));
    expect(screen.getByLabelText(/Password/)).toHaveFocus();
  });

  it("shows the generic credentials message and keeps the typed email but not the password", async () => {
    const user = userEvent.setup();
    const action = failure({
      message: "The email or password is not correct.",
      values: { email: "jane@example.com" },
    });
    render(<AuthForm mode="login" action={action} siteKey="k" />);
    await user.type(screen.getByRole("textbox", { name: /Email/ }), "jane@example.com");
    await user.type(screen.getByLabelText(/Password/), "secret value");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("The email or password is not correct.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /Email/ })).toHaveValue("jane@example.com"),
    );
    expect(screen.getByLabelText(/Password/)).toHaveValue("");
  });

  it("disables the button while a submit is pending, so a double click cannot send twice", async () => {
    const user = userEvent.setup();
    let release: (s: AuthFormState) => void = () => undefined;
    const action = vi.fn(() => new Promise<AuthFormState>((resolve) => (release = resolve)));
    render(<AuthForm mode="login" action={action} siteKey="k" />);
    await user.type(screen.getByRole("textbox", { name: /Email/ }), "a@example.com");
    await user.type(screen.getByLabelText(/Password/), "pw");
    await user.dblClick(screen.getByRole("button", { name: "Sign in" }));
    const busy = await screen.findByRole("button", { name: "Signing in…" });
    expect(busy).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1);
    release({ status: "error", attempt: 1, message: "x" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled());
  });

  it("signup shows a check-your-email confirmation, identical wording for new and existing accounts", async () => {
    const user = userEvent.setup();
    const action: Action = async () => ({
      status: "check-email",
      attempt: 0,
      values: { email: "jane@example.com" },
    });
    render(<AuthForm mode="signup" action={action} siteKey="k" />);
    await user.type(screen.getByRole("textbox", { name: /Email/ }), "jane@example.com");
    await user.type(screen.getByLabelText(/Password/), "long enough password");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "If jane@example.com can be used to create an account",
    );
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
  });

  it("forwards a validated next path as a hidden field", () => {
    const { container } = render(
      <AuthForm mode="login" action={failure({})} siteKey="k" next="/app/customers" />,
    );
    expect(container.querySelector('input[name="next"]')).toHaveValue("/app/customers");
  });

  it("explains a bad email link", () => {
    render(
      <AuthForm
        mode="login"
        action={failure({})}
        siteKey="k"
        notice="That confirmation link is invalid or has expired."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("invalid or has expired");
  });

  it("cannot be submitted when no bot-check key is configured", () => {
    render(<AuthForm mode="login" action={failure({})} siteKey={undefined} />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  });

  it("has no axe violations: idle, with errors, and signup", async () => {
    const user = userEvent.setup();
    const { container, unmount } = render(
      <AuthForm
        mode="login"
        action={failure({ fieldErrors: { email: ["Enter your email address."] } })}
        siteKey="k"
      />,
    );
    await expectNoA11yViolations(container);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("alert");
    await expectNoA11yViolations(container);
    unmount();
    const signup = render(<AuthForm mode="signup" action={failure({})} siteKey="k" />);
    await expectNoA11yViolations(signup.container);
  });

  it("is operable from the keyboard: Tab reaches email, password, then the submit button", async () => {
    const user = userEvent.setup();
    render(<AuthForm mode="login" action={failure({})} siteKey="k" />);
    await user.tab();
    expect(screen.getByRole("textbox", { name: /Email/ })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/Password/)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveFocus();
  });
});

describe("AuthForm in forgot mode", () => {
  it("asks only for the email, and says what the button does", () => {
    render(<AuthForm mode="forgot" action={failure({})} siteKey="k" />);
    expect(screen.getByRole("textbox", { name: /Email/ })).toBeRequired();
    expect(screen.queryByLabelText(/Password/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });
  it("shows the same neutral confirmation whether or not the account exists", async () => {
    const user = userEvent.setup();
    const action: Action = async () => ({
      status: "check-email",
      attempt: 0,
      values: { email: "nobody@example.com" },
    });
    render(<AuthForm mode="forgot" action={action} siteKey="k" />);
    await user.type(screen.getByRole("textbox", { name: /Email/ }), "nobody@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "If an account exists for nobody@example.com, we sent a link",
    );
  });
  it("shows field errors with a focused summary and passes axe", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AuthForm
        mode="forgot"
        action={failure({ fieldErrors: { email: ["Enter your email address."] } })}
        siteKey="k"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    await expectNoA11yViolations(container);
  });
});
