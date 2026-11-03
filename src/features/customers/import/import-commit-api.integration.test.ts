import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** POST /api/v1/imports/customers/commit and the error report, over real HTTP (SIT-239, PRD 7.4, 11.3). */
const server = new RealServer();
let owner: Actor, admin: Actor, member: Actor, viewer: Actor, other: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";
let keyCounter = 0;

/* eslint-disable @typescript-eslint/no-explicit-any */
const b64 = (text: string) => Buffer.from(text).toString("base64");
const post = (
  path: string,
  actor: Actor | null,
  json: unknown,
  org = orgA,
  headers: Record<string, string> = {},
) =>
  server.request(`/api/v1/imports/customers/${path}`, actor, {
    method: "POST",
    json,
    headers: { "X-Organization-Id": org, ...headers },
  });
const preview = async (text: string, actor = owner, org = orgA) => {
  const res = await post("preview", actor, { content: b64(text) }, org);
  expect(res.status).toBeLessThan(300);
  return (await res.json()).data as any;
};
const commit = (job: string, text: string, actor: Actor | null = owner, org = orgA, key?: string) =>
  post(
    "commit",
    actor,
    { importJobId: job, content: b64(text) },
    org,
    key ? { "Idempotency-Key": key } : {},
  );
const key = () => `commit-key-${Date.now()}-${++keyCounter}`;
const body = async (res: Response): Promise<any> => res.json();
const count = (org: string, where = "true") =>
  Number(
    psql(`select count(*) from public.customers where organization_id = '${org}' and ${where}`),
  );
const file = (n: number, prefix: string, withEmail = true, from = 0) =>
  "display_name,email\n" +
  Array.from(
    { length: n },
    (_, i) =>
      `${prefix} ${from + i},${withEmail ? `${prefix.toLowerCase().replace(/ /g, "")}-${from + i}@c.test` : ""}`,
  ).join("\n") +
  "\n";

async function createOrg(actor: Actor, name: string): Promise<string> {
  const res = await server.request("/api/v1/organizations", actor, { json: { name } });
  expect(res.status).toBe(201);
  return (await res.json()).data.id as string;
}
const addMember = (org: string, actor: Actor, role: string) =>
  psql(
    `insert into public.memberships (organization_id, user_id, role) values ('${org}', '${actor.id}', '${role}')`,
  );

beforeAll(async () => {
  await server.start();
  [owner, admin, member, viewer, other, guest] = await Promise.all([
    server.member("imc-owner"),
    server.member("imc-admin"),
    server.member("imc-member"),
    server.member("imc-viewer"),
    server.member("imc-other"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Import Commit Co A");
  orgB = await createOrg(other, "Import Commit Co B");
  addMember(orgA, admin, "admin");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
}, 400_000);

afterAll(() => server.stop());

describe("commit: the happy path", () => {
  it("imports the valid rows, skips the invalid ones, and finishes the job", async () => {
    const text =
      "display_name,email,type\nOne Good,one@good.test,person\n,missing-name@good.test,person\nTwo Good,two@good.test,company\nThree Bad,not-an-email,person\n";
    const job = await preview(text);
    expect(job.counts).toEqual({ total: 4, valid: 2, invalid: 2 });
    const before = count(orgA);
    const res = await commit(job.importJobId, text);
    expect(res.status).toBe(200);
    const { data } = await body(res);
    expect(data).toMatchObject({
      importJobId: job.importJobId,
      status: "committed",
      replayed: false,
      total: 4,
      imported: 2,
      rejected: 2,
      skippedDuplicates: 0,
      failedChunks: [],
      failedRows: 0,
      demoCapReached: false,
    });
    expect(count(orgA)).toBe(before + 2);
    expect(count(orgA, "display_name in ('One Good', 'Two Good')")).toBe(2);
    expect(
      psql(
        `select type from public.customers where organization_id = '${orgA}' and display_name = 'Two Good'`,
      ),
    ).toBe("company");
    expect(
      psql(
        `select status || '|' || imported_rows || '|' || rejected_rows from public.import_jobs where id = '${job.importJobId}'`,
      ),
    ).toBe("committed|2|2");
    // history: a created event per customer and one summary event
    expect(
      psql(
        `select count(*) from public.activity_events where organization_id = '${orgA}' and action = 'created' and summary like '%Good%'`,
      ),
    ).toBe("2");
    expect(
      psql(
        `select count(*) from public.activity_events where entity_id = '${job.importJobId}' and action = 'imported'`,
      ),
    ).toBe("1");
    expect(
      psql(
        `select created_by from public.customers where organization_id = '${orgA}' and display_name = 'One Good'`,
      ),
    ).toBe(owner.id);
  });

  it("skips an e-mail already in the workspace and one repeated in the file, and says so", async () => {
    await server.request("/api/v1/customers", owner, {
      json: { displayName: "Dup Origin", email: "origin@dups.test" },
      headers: { "X-Organization-Id": orgA },
    });
    const text =
      "display_name,email\nDup Fresh,fresh@dups.test\nDup Origin Again,ORIGIN@dups.test\nDup Fresh Twin,fresh@dups.test\n";
    const job = await preview(text);
    const { data } = await body(await commit(job.importJobId, text));
    expect(data).toMatchObject({ imported: 1, skippedDuplicates: 2, rejected: 0 });
    expect(count(orgA, "email = 'fresh@dups.test'")).toBe(1);
  });
});

describe("commit: exactly once", () => {
  it("a retry with the same Idempotency-Key replays the response and writes nothing", async () => {
    const text = file(3, "Replay Key");
    const job = await preview(text);
    const k = key();
    const first = await commit(job.importJobId, text, owner, orgA, k);
    const a = await body(first);
    const before = count(orgA);
    const again = await commit(job.importJobId, text, owner, orgA, k);
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual(a);
    expect(count(orgA)).toBe(before);
  });

  it("a retry with a NEW key, or none, returns the original result (replayed) and writes nothing", async () => {
    const text = file(3, "Replay Nokey");
    const job = await preview(text);
    const first = await body(await commit(job.importJobId, text));
    expect(first.data.imported).toBe(3);
    const before = count(orgA);
    const second = await body(await commit(job.importJobId, text, owner, orgA, key()));
    expect(second.data).toMatchObject({ imported: 3, replayed: true, status: "committed" });
    expect(count(orgA)).toBe(before);
  });

  it("five simultaneous submits with different keys import the rows once", async () => {
    const text = file(40, "Race Row");
    const job = await preview(text);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => commit(job.importJobId, text, owner, orgA, key())),
    );
    const bodies = await Promise.all(results.map(body));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(bodies.filter((b) => b.data.replayed === false)).toHaveLength(1);
    expect(bodies.every((b) => b.data.imported === 40)).toBe(true);
    expect(count(orgA, "display_name like 'Race Row %'")).toBe(40);
  });

  it("re-uploading the same file after it was imported returns that finished job and imports nothing more", async () => {
    const text = file(2, "Reupload Same");
    const job = await preview(text);
    await commit(job.importJobId, text);
    const again = await post("preview", owner, { content: b64(text) });
    expect(again.status).toBe(200);
    const d = (await again.json()).data;
    expect(d.importJobId).toBe(job.importJobId);
    expect(d.status).toBe("committed");
    const before = count(orgA);
    const res = await body(await commit(d.importJobId, text));
    expect(res.data.replayed).toBe(true);
    expect(count(orgA)).toBe(before);
  });
});

describe("commit: chunks", () => {
  it("imports 250 rows (three chunks) in one go", async () => {
    const text = file(250, "Chunky", false);
    const job = await preview(text);
    const { data } = await body(await commit(job.importJobId, text));
    expect(data).toMatchObject({
      imported: 250,
      failedChunks: [],
      failedRows: 0,
      status: "committed",
    });
    expect(count(orgA, "display_name like 'Chunky %'")).toBe(250);
  });

  it("a failure in chunk 3 keeps chunks 1, 2 and 4, rolls back chunk 3 only, and reports it", async () => {
    psql(
      `create or replace function public.zz_import_boom() returns trigger language plpgsql as $$ begin if new.display_name = 'BOOM Row' then raise exception 'forced failure'; end if; return new; end $$`,
    );
    psql(
      `create trigger zz_import_boom before insert on public.customers for each row execute function public.zz_import_boom()`,
    );
    try {
      // 450 rows: the data rows 201-300 are chunk 3; row 250 of the file is the one that fails
      const lines = Array.from({ length: 450 }, (_, i) =>
        i === 249 ? "BOOM Row" : `Fail Chunk ${i}`,
      );
      const text = "display_name\n" + lines.join("\n") + "\n";
      const job = await preview(text);
      const res = await commit(job.importJobId, text);
      expect(res.status).toBe(200);
      const { data } = await body(res);
      expect(data).toMatchObject({
        status: "committed",
        imported: 350,
        failedChunks: [3],
        failedRows: 100,
      });
      expect(count(orgA, "display_name like 'Fail Chunk %'")).toBe(350);
      expect(count(orgA, "display_name = 'BOOM Row'")).toBe(0);
      expect(count(orgA, "display_name = 'Fail Chunk 150'")).toBe(1); // chunk 2
      expect(count(orgA, "display_name = 'Fail Chunk 350'")).toBe(1); // chunk 4
      expect(count(orgA, "display_name = 'Fail Chunk 210'")).toBe(0); // chunk 3, rolled back with its neighbour
      // the report lists the failed rows by number
      const report = await server.request(
        `/api/v1/imports/customers/${job.importJobId}/errors`,
        owner,
        {
          headers: { "X-Organization-Id": orgA },
        },
      );
      const csv = await report.text();
      expect(csv).toContain("COMMIT_FAILED");
      expect(csv.split("\r\n").filter((l) => l.includes("COMMIT_FAILED"))).toHaveLength(100);
    } finally {
      psql(`drop trigger if exists zz_import_boom on public.customers`);
      psql(`drop function if exists public.zz_import_boom()`);
    }
  });
});

describe("commit: the demo cap", () => {
  it("imports up to the cap, then answers 429 with the partial result", async () => {
    const have = count(demoOrg);
    const room = 50 - have;
    const text = file(room + 8, "Demo Row");
    const job = await preview(text, guest, demoOrg);
    expect(job.demo).toEqual({ remaining: room, wouldExceed: true });
    const res = await commit(job.importJobId, text, guest, demoOrg);
    expect(res.status).toBe(429);
    const err = (await body(res)).error;
    expect(err.code).toBe("DEMO_CAP");
    expect(err.meta.result).toMatchObject({
      imported: room,
      notImportedDemoCap: 8,
      demoCapReached: true,
      status: "committed",
    });
    expect(count(demoOrg)).toBe(50);
    // retrying does not add anything, and tells the same story
    const again = await commit(job.importJobId, text, guest, demoOrg);
    expect(again.status).toBe(429);
    expect(count(demoOrg)).toBe(50);
  });
});

describe("commit: refusals", () => {
  it("422 when the file is not the one that was previewed, and the job stays previewed", async () => {
    const text = file(2, "Mismatch");
    const job = await preview(text);
    const res = await commit(job.importJobId, text + "Extra Row,\n");
    expect(res.status).toBe(422);
    expect((await body(res)).error.code).toBe("IMPORT_FILE_MISMATCH");
    expect(psql(`select status from public.import_jobs where id = '${job.importJobId}'`)).toBe(
      "previewed",
    );
    expect(count(orgA, "display_name like 'Mismatch %'")).toBe(0);
  });

  it("404 for an unknown job and for another workspace's job", async () => {
    const text = file(2, "Foreign");
    const job = await preview(text, other, orgB);
    expect((await commit("00000000-0000-4000-8000-000000000999", text)).status).toBe(404);
    const res = await commit(job.importJobId, text, owner, orgA);
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("IMPORT_JOB_NOT_FOUND");
    expect(count(orgA, "display_name like 'Foreign %'")).toBe(0);
  });

  it("403 for a viewer; 401 signed out; 422 for a malformed body", async () => {
    const text = file(2, "Viewer Try");
    const job = await preview(text);
    expect((await commit(job.importJobId, text, viewer)).status).toBe(403);
    expect((await commit(job.importJobId, text, null)).status).toBe(401);
    expect((await post("commit", owner, { importJobId: "nope", content: b64(text) })).status).toBe(
      422,
    );
    expect((await post("commit", owner, { importJobId: job.importJobId })).status).toBe(422);
    expect(
      (await post("commit", owner, { importJobId: job.importJobId, content: b64(text), extra: 1 }))
        .status,
    ).toBe(422);
    expect(count(orgA, "display_name like 'Viewer Try %'")).toBe(0);
  });

  it("only the person who started an import, or an owner or admin, can finish it", async () => {
    const text = file(2, "Who Commits");
    const job = await preview(text, admin);
    const denied = await commit(job.importJobId, text, member);
    expect(denied.status).toBe(403);
    const ok = await commit(job.importJobId, text, owner);
    expect(ok.status).toBe(200);
    const text2 = file(2, "Member Own");
    const job2 = await preview(text2, member);
    expect((await commit(job2.importJobId, text2, member)).status).toBe(200);
  });

  it("409 when the preview has expired", async () => {
    const text = file(2, "Expired Import");
    const job = await preview(text);
    psql(`alter table public.import_jobs disable trigger import_jobs_protect_columns`);
    psql(
      `update public.import_jobs set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = '${job.importJobId}'`,
    );
    psql(`alter table public.import_jobs enable trigger import_jobs_protect_columns`);
    const res = await commit(job.importJobId, text);
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("IMPORT_JOB_EXPIRED");
    expect(count(orgA, "display_name like 'Expired Import %'")).toBe(0);
  });
});

describe("the error report", () => {
  const text = [
    "display_name,email,notes",
    "Report Good,rg@report.test,fine",
    ",secret-person@report.test,SECRET NOTE ONE",
    "Report Bad Mail,this is not mail,SECRET NOTE TWO",
  ].join("\n");

  it("is a CSV of row, field, code and a fixed explanation, with nothing from the file", async () => {
    const job = await preview(text);
    await commit(job.importJobId, text);
    const res = await server.request(`/api/v1/imports/customers/${job.importJobId}/errors`, owner, {
      headers: { "X-Organization-Id": orgA },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(
      /attachment; filename="import-errors-[0-9a-f]{8}\.csv"/,
    );
    expect(res.headers.get("x-report-truncated")).toBe("false");
    const csv = await res.text();
    expect(csv.split("\r\n")).toEqual([
      "row,field,code,explanation",
      "3,displayName,REQUIRED,A required value is missing.",
      "4,email,INVALID_EMAIL,Not a valid email address.",
      "",
    ]);
    expect(csv).not.toMatch(/SECRET|secret-person|this is not mail|Report Bad/);
  });

  it("explains every kind of problem in words, including a line break in a single-line field [SIT-266]", async () => {
    const file = [
      "display_name,company_name,email",
      "Report Fine Two,,rf2@report.test",
      'Report Line Break,"Acme\nInc",',
      "Report Long Phone Name,,this is not mail",
      "R,,",
    ].join("\n");
    const job = await preview(file);
    await commit(job.importJobId, file);
    const res = await server.request(`/api/v1/imports/customers/${job.importJobId}/errors`, owner, {
      headers: { "X-Organization-Id": orgA },
    });
    expect((await res.text()).split("\r\n")).toEqual([
      "row,field,code,explanation",
      "3,companyName,SINGLE_LINE_ONLY,Must be on a single line.",
      "4,email,INVALID_EMAIL,Not a valid email address.",
      "5,displayName,WRONG_LENGTH,The value is too short or too long.",
      "",
    ]);
  });

  it("any member can read it (a viewer too), another workspace cannot, a bad id is 400", async () => {
    const job = await preview(text + "\n");
    const get = (id: string, actor: Actor, org = orgA) =>
      server.request(`/api/v1/imports/customers/${id}/errors`, actor, {
        headers: { "X-Organization-Id": org },
      });
    expect((await get(job.importJobId, viewer)).status).toBe(200);
    expect((await get(job.importJobId, other, orgB)).status).toBe(404);
    expect((await get("not-a-uuid", owner)).status).toBe(400);
    expect((await get("00000000-0000-4000-8000-000000000999", owner)).status).toBe(404);
  });
});
