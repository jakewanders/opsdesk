import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Input } from "@/components/ui/input";
import { expectNoA11yViolations } from "@/test/axe";
import { ErrorSummary } from "./error-summary";
import { FormField } from "./form-field";

describe("FormField error motion", () => {
  it("slides its error in (movement only: a half-transparent error fails contrast checks)", () => {
    render(
      <FormField label="Email" error="Enter a valid email.">
        {(c) => <Input type="email" {...c} />}
      </FormField>,
    );
    const message = screen.getByText("Enter a valid email.").closest("p")!;
    expect(message).toHaveClass("animate-in", "slide-in-from-top-1");
    expect(message).not.toHaveClass("fade-in");
  });
});

describe("FormField", () => {
  it("gives the control an accessible name from its label", () => {
    render(<FormField label="Email">{(c) => <Input type="email" {...c} />}</FormField>);
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).not.toHaveAttribute("aria-invalid");
  });

  it("links the hint and the error with aria-describedby and marks the control invalid", () => {
    render(
      <FormField label="Email" hint="We never share it." error="Enter an email address.">
        {(c) => <Input type="email" {...c} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("We never share it. Error: Enter an email address.");
  });

  it("states the problem in words, not only color", () => {
    render(
      <FormField label="Name" error="Enter at least 2 characters.">
        {(c) => <Input {...c} />}
      </FormField>,
    );
    expect(screen.getByText(/Error:/)).toHaveClass("sr-only");
    expect(screen.getByText("Enter at least 2 characters.")).toBeVisible();
  });

  it("marks required fields for assistive tech and visually", () => {
    render(
      <FormField label="Name" required>
        {(c) => <Input {...c} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: /Name/ });
    expect(input).toHaveAttribute("aria-required", "true");
    expect(screen.getByText("(required)")).toHaveClass("sr-only");
  });

  it("uses a custom id so a summary can link to it", () => {
    render(
      <FormField label="Phone" id="phone">
        {(c) => <Input {...c} />}
      </FormField>,
    );
    expect(screen.getByLabelText("Phone")).toHaveAttribute("id", "phone");
  });

  it("has no axe violations for a valid and an invalid field", async () => {
    const { container } = render(
      <form>
        <FormField label="Email" hint="Work address">
          {(c) => <Input type="email" {...c} />}
        </FormField>
        <FormField label="Name" error="Enter a name." required>
          {(c) => <Input {...c} />}
        </FormField>
      </form>,
    );
    await expectNoA11yViolations(container);
  });
});

function Demo() {
  const [submits, setSubmits] = useState(0);
  const [errors, setErrors] = useState<{ fieldId: string; message: string }[]>([]);
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setSubmits((n) => n + 1);
        setErrors([
          { fieldId: "email", message: "Enter an email address." },
          { fieldId: "name", message: "Enter a name." },
        ]);
      }}
    >
      <ErrorSummary errors={errors} focusKey={submits} />
      <FormField label="Name" id="name" error={errors.find((e) => e.fieldId === "name")?.message}>
        {(c) => <Input {...c} />}
      </FormField>
      <FormField
        label="Email"
        id="email"
        error={errors.find((e) => e.fieldId === "email")?.message}
      >
        {(c) => <Input type="email" {...c} />}
      </FormField>
      <button type="submit">Save</button>
    </form>
  );
}

describe("ErrorSummary", () => {
  it("renders nothing when there are no errors", () => {
    const { container } = render(<ErrorSummary errors={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is an alert with a heading and one link per error", () => {
    render(
      <ErrorSummary
        errors={[
          { fieldId: "a", message: "Enter A." },
          { fieldId: "b", message: "Enter B." },
        ]}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAccessibleName("");
    expect(screen.getByRole("heading", { name: "There is a problem" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Enter A." })).toHaveAttribute("href", "#a");
    expect(screen.getByRole("link", { name: "Enter B." })).toHaveAttribute("href", "#b");
  });

  it("takes focus when a submit fails, then Tab reaches the first error link", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Enter an email address." })).toHaveFocus();
  });

  it("moves focus to the field when its error link is activated", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("link", { name: "Enter a name." }));
    expect(screen.getByLabelText("Name")).toHaveFocus();
  });

  it("takes focus again after a second failed submit", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(screen.getByRole("link", { name: "Enter a name." }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveFocus();
  });

  it("links each summary entry to a field that exists and is invalid", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    for (const id of ["name", "email"]) {
      expect(document.getElementById(id)).toHaveAttribute("aria-invalid", "true");
    }
  });

  it("has no axe violations with errors showing", async () => {
    const user = userEvent.setup();
    const { container } = render(<Demo />);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await expectNoA11yViolations(container);
  });
});
