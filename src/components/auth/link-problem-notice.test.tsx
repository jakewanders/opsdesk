import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LinkProblemNotice } from "./link-problem-notice";

afterEach(() => {
  window.location.hash = "";
});

describe("LinkProblemNotice", () => {
  it("shows the server's notice when the address has no error details", () => {
    render(<LinkProblemNotice fallback="That link is invalid or has expired." />);
    expect(screen.getByRole("alert")).toHaveTextContent("That link is invalid or has expired.");
  });
  it("explains a used or expired link when Supabase put otp_expired in the address", () => {
    window.location.hash = "#error=access_denied&error_code=otp_expired";
    render(<LinkProblemNotice fallback="fallback" />);
    expect(screen.getByRole("alert")).toHaveTextContent(/already used or has expired/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/already confirmed your address, sign in/i);
  });
});
