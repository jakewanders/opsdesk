import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientProvider } from "@/lib/api-client/provider";
import { OpportunitiesView } from "./opportunities-view";

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/opportunities",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("./pipeline-board", () => ({ PipelineBoard: () => <p>BOARD VIEW</p> }));
vi.mock("./opportunity-list", () => ({ OpportunityList: () => <p>LIST VIEW</p> }));

const stubWidth = (wide: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: wide,
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
const view = () =>
  render(
    <ApiClientProvider organizationId="org-1">
      <OpportunitiesView canWrite currentUserId="u1" />
    </ApiClientProvider>,
  );

beforeEach(() => {
  search = "";
});
afterEach(() => vi.unstubAllGlobals());

describe("OpportunitiesView [SIT-228]", () => {
  it("no choice: a wide screen gets the board, a narrow one the list", () => {
    stubWidth(true);
    view().unmount();
    stubWidth(true);
    const wide = view();
    expect(screen.getByText("BOARD VIEW")).toBeInTheDocument();
    wide.unmount();
    stubWidth(false);
    view();
    expect(screen.getByText("LIST VIEW")).toBeInTheDocument();
  });
  it("an explicit ?view= wins over the screen width", () => {
    stubWidth(false);
    search = "view=board";
    view();
    expect(screen.getByText("BOARD VIEW")).toBeInTheDocument();
  });
  it("?view=list on a wide screen shows the list", () => {
    stubWidth(true);
    search = "view=list";
    view();
    expect(screen.getByText("LIST VIEW")).toBeInTheDocument();
  });
});
