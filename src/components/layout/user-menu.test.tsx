import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { UserMenu } from "./user-menu";

vi.mock("@/lib/auth/actions", () => ({ logoutAction: vi.fn() }));

describe("UserMenu sign out", () => {
  it("clears the client cache when the sign-out form is submitted", async () => {
    const grabbed: { client?: ReturnType<typeof useQueryClient> } = {};
    function Grab() {
      const qc = useQueryClient();
      useEffect(() => {
        grabbed.client = qc;
      });
      return null;
    }
    render(
      <ApiClientProvider organizationId="org-1">
        <Grab />
        <UserMenu user={{ name: "Pat", email: "pat@example.test" }} />
      </ApiClientProvider>,
    );
    grabbed.client!.setQueryData(["org-1", "customers"], { data: [], meta: {} });
    expect(grabbed.client!.getQueryCache().getAll()).toHaveLength(1);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    expect(grabbed.client!.getQueryCache().getAll()).toHaveLength(0);
  });

  it("still renders and signs out without a provider (the menu is also used outside /app)", async () => {
    render(<UserMenu user={{ name: "Pat" }} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    expect(await screen.findByRole("menuitem", { name: "Sign out" })).toBeInTheDocument();
  });
});
