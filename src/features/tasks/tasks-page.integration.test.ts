import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** [SIT-237] The task list page over real HTTP: first paint from the server, scoped by RLS, URL state applied. */
const server = new RealServer();
let guest: Actor, owner: Actor, viewer: Actor;

beforeAll(async () => {
  await server.start();
  [guest, owner, viewer] = await Promise.all([
    server.guest(),
    server.member("tp-owner"),
    server.member("tp-viewer"),
  ]);
  expect((await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" })).status).toBe(
    200,
  );
  const res = await server.request("/api/v1/organizations", owner, {
    json: { name: "Task Page Co" },
  });
  expect(res.status).toBe(201);
  const org = (await res.json()).data.id as string;
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${viewer.id}', 'viewer')`,
  );
  const mk = await server.request("/api/v1/tasks", owner, {
    json: { title: "Real workspace task", dueDate: "2020-01-01" },
    headers: { "X-Organization-Id": org },
  });
  expect(mk.status).toBe(201);
}, 400_000);
afterAll(() => server.stop());

const page = async (path: string, actor: Actor) =>
  (await (await server.request(path, actor)).text()).replace(/<!-- -->/g, "");

describe("/app/tasks", () => {
  it("a demo guest gets the seeded 24 tasks in the server-rendered HTML, with Overdue and Due today marked in words", async () => {
    const html = await page("/app/tasks", guest);
    expect(html).toContain("<table");
    expect(html).toContain("Showing 1 to 24 of 24");
    expect(html).toContain("Overdue");
    expect(html).toContain("Due today");
    expect(html).toContain("Mark ");
  });
  it("URL state is applied on the server: overdue, assigned to me, status and grouping", async () => {
    expect(await page("/app/tasks?overdue=true", guest)).toContain("Showing 1 to 5 of 5");
    const mine = await page("/app/tasks?mine=true", guest);
    expect(mine).toMatch(/Showing 1 to 12 of 12/);
    const done = await page("/app/tasks?status=done", guest);
    expect(done).toContain("Showing 1 to 5 of 5");
    expect(done).not.toContain("Due today");
    expect(done).toContain("Completed ");
    const grouped = await page("/app/tasks?group=status", guest);
    expect(grouped).toContain('scope="rowgroup"');
    expect(grouped).toContain("grouped within this page");
    expect(await page("/app/tasks?q=zzzznomatchzzzz", guest)).toContain("No tasks match");
  });
  it("garbage URL state falls back to defaults instead of failing", async () => {
    const res = await server.request(
      "/app/tasks?page=-1&limit=abc&status=%27%3Bdrop&sort=x&overdue=yes",
      guest,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<table");
  });
  it("a real workspace sees only its own task, overdue by the org's calendar; a viewer gets read-only rows", async () => {
    const html = await page("/app/tasks", owner);
    expect(html).toContain("Real workspace task");
    expect(html).toContain("Showing 1 to 1 of 1");
    expect(html).toContain("Overdue");
    expect(html).not.toContain("Showing 1 to 24");
    expect(html).toContain("Mark Real workspace task complete");
    const v = await page("/app/tasks", viewer);
    expect(v).toContain("Real workspace task");
    expect(v).not.toContain("Mark Real workspace task complete");
  });
});
