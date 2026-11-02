import { describe, expect, it, vi } from "vitest";
import { restartDemo } from "./restart";

const client = (result: object | (() => never)) =>
  ({ rpc: vi.fn(async () => (typeof result === "function" ? result() : result)) }) as never;

describe("restartDemo", () => {
  it("returns the new organization", async () => {
    const supabase = client({ data: { organization_id: "org-1" }, error: null });
    expect(await restartDemo(supabase)).toEqual({ ok: true, organizationId: "org-1" });
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "bootstrap_demo_workspace",
    );
  });
  it("explains capacity, non-guests and anything else without leaking internals", async () => {
    expect(
      await restartDemo(client({ data: null, error: { code: "OD429", message: "x" } })),
    ).toMatchObject({ ok: false, reason: "busy" });
    expect(
      await restartDemo(client({ data: null, error: { code: "OD403", message: "x" } })),
    ).toMatchObject({ ok: false, reason: "not_guest" });
    const failed = await restartDemo(
      client({ data: null, error: { code: "XX000", message: "relation secret_table failed" } }),
    );
    expect(failed).toMatchObject({ ok: false, reason: "failed" });
    expect(JSON.stringify(failed)).not.toContain("secret_table");
  });
  it("never throws", async () => {
    expect(
      await restartDemo(
        client(() => {
          throw new Error("network");
        }),
      ),
    ).toMatchObject({ ok: false, reason: "failed" });
  });
});
