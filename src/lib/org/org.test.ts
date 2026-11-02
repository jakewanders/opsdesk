import { describe, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "@/lib/api/organizations";
import { resolveActiveWorkspace } from "./active-org";
import { createWorkspace, isMemberOf } from "./workspace-core";

const ws = (id: string, name = id, over: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  id,
  name,
  kind: "real",
  role: "owner",
  timezone: "UTC",
  expiresAt: null,
  secondsRemaining: null,
  expired: false,
  ...over,
});
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const FOREIGN = "f0000000-0000-4000-8000-00000000000f";

describe("resolveActiveWorkspace", () => {
  it("has nothing to select with no workspaces", () => {
    expect(resolveActiveWorkspace(A, [])).toEqual({ status: "none" });
  });
  it("defaults to the only workspace", () => {
    expect(resolveActiveWorkspace(undefined, [ws(A)])).toEqual({
      status: "selected",
      workspace: ws(A),
    });
    expect(resolveActiveWorkspace("garbage", [ws(A)])).toMatchObject({ status: "selected" });
  });
  it("makes a user with several workspaces choose (no silent default)", () => {
    expect(resolveActiveWorkspace(undefined, [ws(A), ws(B)])).toEqual({ status: "choose" });
    expect(resolveActiveWorkspace(null, [ws(A), ws(B)])).toEqual({ status: "choose" });
    expect(resolveActiveWorkspace("", [ws(A), ws(B)])).toEqual({ status: "choose" });
  });
  it("honours a stored preference that names one of the caller's own workspaces", () => {
    expect(resolveActiveWorkspace(B, [ws(A), ws(B)])).toMatchObject({
      status: "selected",
      workspace: { id: B },
    });
    expect(resolveActiveWorkspace(B.toUpperCase(), [ws(A), ws(B)])).toMatchObject({
      status: "selected",
      workspace: { id: B },
    });
  });
  it("ignores a tampered preference naming a foreign tenant, malformed text or injection", () => {
    for (const bad of [
      FOREIGN,
      "not-a-uuid",
      `${A}x`,
      "' or 1=1 --",
      "../../etc/passwd",
      "<script>",
      `${A},${B}`,
    ]) {
      expect(resolveActiveWorkspace(bad, [ws(A), ws(B)]), bad).toEqual({ status: "choose" });
    }
    // a single-workspace user with a foreign id just gets their own
    expect(resolveActiveWorkspace(FOREIGN, [ws(A)])).toMatchObject({
      status: "selected",
      workspace: { id: A },
    });
  });
});

describe("createWorkspace", () => {
  const client = (result: object) => ({ rpc: vi.fn(async () => result) }) as never;
  const form = { name: "Acme Plumbing", industry: "", timezone: "America/Chicago" };
  it("never reaches the database for a guest", async () => {
    const supabase = client({ data: "x", error: null });
    const r = await createWorkspace(supabase, { isAnonymous: true }, form);
    expect(r).toMatchObject({
      ok: false,
      reason: "guest",
      message: expect.stringContaining("Create an account to keep your data"),
    });
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });
  it("returns field errors from the same schema as the API", async () => {
    const supabase = client({ data: "x", error: null });
    const r = await createWorkspace(
      supabase,
      { isAnonymous: false },
      { name: "A", industry: "", timezone: "Mars/Base" },
    );
    expect(r).toMatchObject({ ok: false, reason: "invalid" });
    expect(Object.keys((r as { fieldErrors: object }).fieldErrors).sort()).toEqual([
      "name",
      "timezone",
    ]);
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).not.toHaveBeenCalled();
  });
  it("calls create_real_organization with the cleaned values, defaulting the time zone to UTC", async () => {
    const supabase = client({ data: "new-id", error: null });
    expect(
      await createWorkspace(
        supabase,
        { isAnonymous: false },
        { name: "  Acme  ", industry: " Plumbing ", timezone: "" },
      ),
    ).toEqual({ ok: true, id: "new-id" });
    expect((supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc).toHaveBeenCalledWith(
      "create_real_organization",
      { org_name: "Acme", org_industry: "Plumbing", org_timezone: "UTC" },
    );
  });
  it("maps database refusals to friendly reasons without leaking internals", async () => {
    const run = (code: string) =>
      createWorkspace(
        client({ data: null, error: { code, message: "relation secret_table" } }),
        { isAnonymous: false },
        form,
      );
    expect(await run("OD403")).toMatchObject({ reason: "guest" });
    expect(await run("OD429")).toMatchObject({ reason: "limit" });
    expect(await run("OD422")).toMatchObject({ reason: "invalid" });
    const other = await run("XX000");
    expect(other).toMatchObject({ reason: "failed" });
    expect(JSON.stringify(other)).not.toContain("secret_table");
  });
  it("never throws", async () => {
    const boom = {
      rpc: async () => {
        throw new Error("network");
      },
    } as never;
    expect(await createWorkspace(boom, { isAnonymous: false }, form)).toMatchObject({
      ok: false,
      reason: "failed",
    });
  });
});

describe("isMemberOf", () => {
  const rows = (ids: string[]) =>
    ({
      from: () => ({
        select: () => ({
          eq: () => ({
            limit: async () => ({
              data: ids.map((id) => ({
                role: "owner",
                organizations: { id, name: id, kind: "real", expires_at: null, timezone: "UTC" },
              })),
              error: null,
            }),
          }),
        }),
      }),
    }) as never;
  it("is true only for the caller's own workspaces", async () => {
    expect(await isMemberOf(rows([A, B]), "u", B)).toBe(true);
    expect(await isMemberOf(rows([A, B]), "u", B.toUpperCase())).toBe(true);
    expect(await isMemberOf(rows([A, B]), "u", FOREIGN)).toBe(false);
    expect(await isMemberOf(rows([]), "u", A)).toBe(false);
  });
});
