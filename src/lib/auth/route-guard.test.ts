import { describe, expect, it } from "vitest";
import {
  decideRoute,
  DEMO_PATH,
  ORG_SETUP_PATH,
  type GuardUser,
  type WorkspaceState,
} from "./route-guard";
import { resolveWorkspaceState } from "./workspace-state";

const member: GuardUser = { isAnonymous: false };
const guest: GuardUser = { isAnonymous: true };

const decide = (pathname: string, user: GuardUser, state: WorkspaceState = "ready", search = "") =>
  decideRoute({ pathname, search, user, workspace: async () => state });

describe("signed-out visitors", () => {
  it("are sent from /app and every /app/* page to /login with the path as next", async () => {
    expect(await decide("/app", null)).toBe("/login?next=%2Fapp");
    expect(await decide("/app/customers", null)).toBe("/login?next=%2Fapp%2Fcustomers");
    expect(await decide("/app/customers/abc-123", null)).toBe(
      "/login?next=%2Fapp%2Fcustomers%2Fabc-123",
    );
  });
  it("keep the query string in next, encoded", async () => {
    expect(await decide("/app/customers", null, "ready", "?stage=won&page=2")).toBe(
      "/login?next=%2Fapp%2Fcustomers%3Fstage%3Dwon%26page%3D2",
    );
  });
  it("are never asked for the workspace (no database call)", async () => {
    let called = false;
    await decideRoute({
      pathname: "/app",
      search: "",
      user: null,
      workspace: async () => ((called = true), "ready"),
    });
    expect(called).toBe(false);
  });
  it("can still open public pages", async () => {
    for (const p of [
      "/",
      "/login",
      "/signup",
      "/demo",
      "/privacy",
      "/terms",
      "/forgot-password",
      "/reset-password",
      "/auth/callback",
    ]) {
      expect(await decide(p, null), p).toBeNull();
    }
  });
  it("are not fooled by look-alike paths", async () => {
    for (const p of ["/application", "/apple", "/apps", "/app-x"])
      expect(await decide(p, null), p).toBeNull();
  });
});

describe("signed-in members on /login and /signup", () => {
  it("go to /app by default", async () => {
    expect(await decide("/login", member)).toBe("/app");
    expect(await decide("/signup", member)).toBe("/app");
  });
  it("go to a validated next", async () => {
    expect(await decide("/login", member, "ready", "?next=/app/customers")).toBe("/app/customers");
  });
  it("fall back to /app for every open-redirect payload", async () => {
    for (const next of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "%2F%2Fevil.com",
      "javascript:alert(1)",
      "/\\\\evil.com",
      "http://evil.com/app",
      "/app/../../evil",
      "data:text/html,x",
    ]) {
      expect(await decide("/login", member, "ready", `?next=${next}`), next).toBe("/app");
      expect(
        await decide("/login", member, "ready", `?next=${encodeURIComponent(next)}`),
        `enc ${next}`,
      ).toBe("/app");
    }
  });
  it("leave a demo guest alone, so they can create a real account", async () => {
    expect(await decide("/login", guest)).toBeNull();
    expect(await decide("/signup", guest)).toBeNull();
  });
});

describe("workspace rules on /app/*", () => {
  it("members with a workspace pass", async () => {
    expect(await decide("/app/customers", member, "ready")).toBeNull();
  });
  it("members with no organization go to org setup, and setup itself is not redirected", async () => {
    expect(await decide("/app", member, "none")).toBe(ORG_SETUP_PATH);
    expect(await decide("/app/customers", member, "none")).toBe(ORG_SETUP_PATH);
    expect(await decide(ORG_SETUP_PATH, member, "none")).toBeNull();
  });
  it("a guest whose demo expired goes to /demo", async () => {
    expect(await decide("/app", guest, "expired-demo")).toBe(DEMO_PATH);
    expect(await decide("/app/tasks", guest, "expired-demo")).toBe(DEMO_PATH);
  });
  it("a guest with no workspace goes to /demo to start one", async () => {
    expect(await decide("/app", guest, "none")).toBe(DEMO_PATH);
  });
  it("a live guest passes", async () => {
    expect(await decide("/app", guest, "ready")).toBeNull();
  });
  it("an undeterminable workspace never redirects (authorization is elsewhere)", async () => {
    expect(await decide("/app", member, "unknown")).toBeNull();
    expect(await decide("/app", guest, "unknown")).toBeNull();
  });
  it("/demo is never redirected away from, even for an expired guest", async () => {
    for (const state of ["ready", "none", "expired-demo", "unknown"] as const) {
      expect(await decide("/demo", guest, state), state).toBeNull();
      expect(await decide("/demo", member, state), state).toBeNull();
    }
  });
});

describe("no redirect loops", () => {
  it("every start path settles within two hops for every user and workspace state", async () => {
    const users: GuardUser[] = [null, member, guest];
    const states: WorkspaceState[] = ["ready", "none", "expired-demo", "unknown"];
    const paths = [
      "/",
      "/login",
      "/signup",
      "/demo",
      "/app",
      "/app/customers",
      ORG_SETUP_PATH,
      "/app/settings/members",
    ];
    for (const user of users) {
      for (const state of states) {
        for (const start of paths) {
          let current = start;
          let search = "";
          let hops = 0;
          for (;;) {
            const target = await decide(current, user, state, search);
            if (target === null) break;
            hops += 1;
            expect(hops, `${JSON.stringify(user)} ${state} ${start}`).toBeLessThanOrEqual(2);
            const [path, query = ""] = target.split("?");
            current = path;
            search = query ? `?${query}` : "";
          }
        }
      }
    }
  });
});

describe("resolveWorkspaceState", () => {
  const client = (result: { data: unknown; error: unknown }) =>
    ({
      from: () => ({ select: () => ({ eq: () => ({ limit: async () => result }) }) }),
    }) as unknown as Parameters<typeof resolveWorkspaceState>[0];
  const now = new Date("2026-11-01T12:00:00Z");
  const live = { organizations: { kind: "demo", expires_at: "2026-11-02T12:00:00Z" } };
  const dead = { organizations: { kind: "demo", expires_at: "2026-11-01T11:59:59Z" } };
  const real = { organizations: { kind: "real", expires_at: null } };

  it("none when the user has no membership", async () => {
    expect(await resolveWorkspaceState(client({ data: [], error: null }), "u", now)).toBe("none");
  });
  it("ready for a real org or a live demo", async () => {
    expect(await resolveWorkspaceState(client({ data: [real], error: null }), "u", now)).toBe(
      "ready",
    );
    expect(await resolveWorkspaceState(client({ data: [live], error: null }), "u", now)).toBe(
      "ready",
    );
    expect(await resolveWorkspaceState(client({ data: [dead, real], error: null }), "u", now)).toBe(
      "ready",
    );
  });
  it("expired-demo when every workspace is an expired demo", async () => {
    expect(await resolveWorkspaceState(client({ data: [dead], error: null }), "u", now)).toBe(
      "expired-demo",
    );
  });
  it("treats expiry at exactly now as expired", async () => {
    const edge = { organizations: { kind: "demo", expires_at: now.toISOString() } };
    expect(await resolveWorkspaceState(client({ data: [edge], error: null }), "u", now)).toBe(
      "expired-demo",
    );
  });
  it("unknown on a database error, a refused query, a thrown error, or hidden organizations", async () => {
    expect(
      await resolveWorkspaceState(client({ data: null, error: { code: "42501" } }), "u", now),
    ).toBe("unknown");
    expect(
      await resolveWorkspaceState(
        client({ data: [{ organizations: null }], error: null }),
        "u",
        now,
      ),
    ).toBe("unknown");
    const throwing = {
      from: () => {
        throw new Error("down");
      },
    } as unknown as Parameters<typeof resolveWorkspaceState>[0];
    expect(await resolveWorkspaceState(throwing, "u", now)).toBe("unknown");
  });
});
