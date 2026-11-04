import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthFormState } from "@/lib/auth/form-state";
import { expectNoA11yViolations } from "@/test/axe";
import { ResetPasswordForm } from "./reset-password-form";

const failing = (extra: Partial<AuthFormState>) =>
  vi.fn(async (previous: AuthFormState) => ({
    status: "error" as const,
    attempt: previous.attempt + 1,
    ...extra,
  }));

describe("ResetPasswordForm", () => {
  it("has labelled, required password fields with new-password autocomplete", () => {
    render(<ResetPasswordForm action={failing({})} />);
    expect(screen.getByLabelText(/^New password/)).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText(/Repeat new password/)).toBeRequired();
    expect(screen.getByText("At least 8 characters.")).toBeInTheDocument();
  });
  it("shows server-side field errors, focuses the summary, and links to the field", async () => {
    const user = userEvent.setup();
    render(
      <ResetPasswordForm
        action={failing({ fieldErrors: { confirm: ["The passwords do not match."] } })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert).toHaveFocus());
    await user.click(screen.getByRole("link", { name: "The passwords do not match." }));
    expect(screen.getByLabelText(/Repeat new password/)).toHaveFocus();
    expect(screen.getByLabelText(/Repeat new password/)).toHaveAttribute("aria-invalid", "true");
  });
  it("shows an expired-link message from the server", async () => {
    const user = userEvent.setup();
    render(
      <ResetPasswordForm
        action={failing({ message: "This reset link has expired. Request a new one." })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Save new password" }));
    expect(
      await screen.findByText("This reset link has expired. Request a new one."),
    ).toBeInTheDocument();
  });
  it("locks the button while saving so a double click cannot send twice", async () => {
    const user = userEvent.setup();
    let release: (s: AuthFormState) => void = () => undefined;
    const action = vi.fn(() => new Promise<AuthFormState>((resolve) => (release = resolve)));
    render(<ResetPasswordForm action={action} />);
    await user.type(screen.getByLabelText(/^New password/), "long enough pw");
    await user.type(screen.getByLabelText(/Repeat new password/), "long enough pw");
    await user.dblClick(screen.getByRole("button", { name: "Save new password" }));
    const busy = await screen.findByRole("button", { name: "Save new password" });
    await waitFor(() => expect(busy).toBeDisabled());
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(action).toHaveBeenCalledTimes(1);
    release({ status: "error", attempt: 1, message: "x" });
  });
  it("keeps tab order and has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ResetPasswordForm
        action={failing({ fieldErrors: { password: ["Use at least 8 characters."] } })}
      />,
    );
    await expectNoA11yViolations(container);
    await user.tab();
    expect(screen.getByLabelText(/^New password/)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/Repeat new password/)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save new password" })).toHaveFocus();
  });
});
