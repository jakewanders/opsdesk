import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TurnstileField } from "./turnstile-field";

describe("TurnstileField", () => {
  it("explains the problem and renders no token field when there is no site key", () => {
    const { container } = render(<TurnstileField siteKey={undefined} resetKey={0} />);
    expect(screen.getByRole("alert")).toHaveTextContent("NEXT_PUBLIC_TURNSTILE_SITE_KEY");
    expect(container.querySelector('input[name="captchaToken"]')).toBeNull();
  });
  it("renders an empty token field and a labelled container with a site key", () => {
    const { container } = render(
      <TurnstileField
        siteKey="1x00000000000000000000AA"
        resetKey={0}
        error="Complete the check below."
      />,
    );
    expect(container.querySelector('input[name="captchaToken"]')).toHaveValue("");
    expect(screen.getByRole("group", { name: "Security check" })).toBeInTheDocument();
    expect(screen.getByText("Complete the check below.")).toBeInTheDocument();
  });
});
