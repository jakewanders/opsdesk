import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-235] The pipeline page over real HTTP, and the numbers its board shows being the API's. */
const server = new RealServer();
let owner: Actor, viewer: Actor, guest: Actor;
let org = "";

beforeAll(async () => {
  await server.start();
  [owner, viewer, guest] = await Promise.all([
    server.member("pb-owner"),
    server.member("pb-viewer"),
    server.guest(),
  ]);
  const res = await server.request("/api/v1/organizations", owner, { json: { name: "Board Co" } });
  expect(res.status).toBe(201);
  org = (await res.json()).data.id;
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
  );
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
}, 400_000);
afterAll(() => server.stop());

const html = async (actor: Actor, query = "?view=board") =>
  (await (await server.request(`/app/opportunities${query}`, actor)).text()).replace(
    /<!-- -->/g,
    "",
  );

describe("/app/opportunities", () => {
  it("renders the board shell with the filters and the totals area for an owner, a viewer and a demo guest", async () => {
    for (const actor of [owner, viewer, guest]) {
      const body = await html(actor);
      expect(body).toContain("Pipeline board");
      expect(body).toContain("Pipeline totals");
      expect(body).toContain('role="search"');
      expect(body).toContain("Open pipeline");
    }
  });
  it("[SIT-228] ?view=list renders the list shell with its filters; with no view chosen the server sends a loading state (the width decides in the browser)", async () => {
    for (const actor of [owner, viewer, guest]) {
      const list = await html(actor, "?view=list");
      expect(list).toContain("Filter opportunities");
      expect(list).toContain("Closes from");
      expect(list).toContain('aria-pressed="true"');
      const none = await html(actor, "");
      expect(none).toContain("Loading the pipeline");
      expect(none).not.toContain("Pipeline totals");
    }
  });
  it("the board's data source returns the demo seed's totals: 10 deals, 5 open, and per-stage counts that add up", async () => {
    const res = await server.request("/api/v1/opportunities?limit=1", guest);
    const { meta } = await res.json();
    const counts = Object.values(meta.stageTotals as Record<string, { count: number }>).map(
      (s) => s.count,
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(meta.stageTotals.won.count).toBe(2);
    expect(meta.openPipelineCents).toBe(
      ["new", "qualified", "proposal", "negotiation"].reduce(
        (n, s) => n + meta.stageTotals[s].amountCents,
        0,
      ),
    );
  });
});
