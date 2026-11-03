import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { psql } from "@/test/local-supabase";
import { RealServer, type Actor } from "@/test/real-server";

/** POST /api/v1/imports/customers/preview over real HTTP (production build, local Supabase) (SIT-231, PRD 7.4, 11.1, 11.3). */
const server = new RealServer();
let owner: Actor, member: Actor, viewer: Actor, other: Actor, outsider: Actor, guest: Actor;
let orgA = "";
let orgB = "";
let demoOrg = "";

/* eslint-disable @typescript-eslint/no-explicit-any */
const call = (actor: Actor | null, json: unknown, org = orgA) =>
  server.request("/api/v1/imports/customers/preview", actor, {
    method: "POST",
    json,
    headers: { "X-Organization-Id": org },
  });
const send = (text: string | Buffer, actor: Actor | null = owner, org = orgA) =>
  call(actor, { content: Buffer.from(text).toString("base64") }, org);
const body = async (res: Response): Promise<any> => res.json();
const jobs = (org: string) =>
  Number(psql(`select count(*) from public.import_jobs where organization_id = '${org}'`));
const customers = (org: string) =>
  Number(psql(`select count(*) from public.customers where organization_id = '${org}'`));
const csv = (n: number) =>
  "display_name,email\n" +
  Array.from({ length: n }, (_, i) => `Customer ${i},c${i}@x.test`).join("\n");

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
  [owner, member, viewer, other, outsider, guest] = await Promise.all([
    server.member("imp-owner"),
    server.member("imp-member"),
    server.member("imp-viewer"),
    server.member("imp-other"),
    server.member("imp-outsider"),
    server.guest(),
  ]);
  orgA = await createOrg(owner, "Import Co A");
  orgB = await createOrg(other, "Import Co B");
  addMember(orgA, member, "member");
  addMember(orgA, viewer, "viewer");
  const boot = await server.request("/api/v1/demo/bootstrap", guest, { method: "POST" });
  demoOrg = (await boot.json()).data.organizationId;
}, 400_000);

afterAll(() => server.stop());

describe("a valid preview", () => {
  it("201: counts, first rows, columns and a stored job; no customer is written", async () => {
    const before = customers(orgA);
    const res = await send(
      "display_name,email,favorite_color\nAda Lovelace,ada@x.test,blue\nBob Ross,bob@x.test,green\n",
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    const { data } = await body(res);
    expect(data.counts).toEqual({ total: 2, valid: 2, invalid: 0 });
    expect(data.columns.unknown).toEqual(["favorite_color"]);
    expect(data.columns.mapped.map((m: any) => m.field)).toEqual(["displayName", "email"]);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]).toMatchObject({
      row: 2,
      valid: true,
      values: { displayName: "Ada Lovelace" },
    });
    expect(data.status).toBe("previewed");
    expect(data.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.demo).toBeNull();
    expect(customers(orgA)).toBe(before);
    const row = psql(
      `select status || '|' || total_rows || '|' || rejected_rows || '|' || imported_rows || '|' || created_by from public.import_jobs where id = '${data.importJobId}'`,
    );
    expect(row).toBe(`previewed|2|0|0|${owner.id}`);
  });

  it("handles a byte-order mark, CRLF, quoted commas and embedded newlines", async () => {
    const text =
      '﻿display_name,company_name,notes\r\n"Smith, Ada","Acme, Inc.","line one\r\nline two"\r\nBob,,\r\n';
    const { data } = await body(await send(text));
    expect(data.counts).toEqual({ total: 2, valid: 2, invalid: 0 });
    expect(data.rows[0].values).toMatchObject({
      displayName: "Smith, Ada",
      companyName: "Acme, Inc.",
    });
  });

  it("stores formula-looking cells as plain text (accepted, not evaluated)", async () => {
    const { data } = await body(await send('display_name,notes\n=SUM(A1),"@cmd"\n'));
    expect(data.counts.valid).toBe(1);
  });
});

describe("exact row errors", () => {
  const text = [
    "display_name,email,type,tags",
    "Ada Lovelace,ada@errors.test,person,a;b", // 2 ok
    ",nobody@errors.test,person,", // 3 no name
    "Cy Young,not-an-email,person,", // 4 bad email
    "Di Prince,di@errors.test,robot,", // 5 bad type
    "Ed Wynn,ed@errors.test,company,", // 6 ok
  ].join("\n");

  it("lists every problem with its row, field and code", async () => {
    const { data } = await body(await send(text));
    expect(data.counts).toEqual({ total: 5, valid: 2, invalid: 3 });
    expect(data.errors.map((e: any) => `${e.row}:${e.field}:${e.code}`)).toEqual([
      "3:displayName:REQUIRED",
      "4:email:INVALID_EMAIL",
      "5:type:INVALID_CHOICE",
    ]);
    expect(data.rows.map((r: any) => r.valid)).toEqual([true, false, false, false, true]);
  });

  it("reports each length rule and a line break in a single-line field by field and code [SIT-266]", async () => {
    const long = (n: number) => "x".repeat(n);
    const file = [
      "display_name,company_name,phone,notes",
      `Ada Lovelace,${long(120)},${long(40)},${long(5000)}`, // 2 ok: every field at its limit
      `Bo Peep,${long(121)},,`, // 3 company too long
      `Cy Young,,${long(41)},`, // 4 phone too long
      `Di Prince,,,${long(5001)}`, // 5 notes too long
      'Ed Wynn,"Acme\nInc",,"two\nlines are fine here"', // 6 line break in a single-line field
      `A,,,`, // 7 name too short
    ].join("\n");
    const { data } = await body(await send(file));
    expect(data.counts).toEqual({ total: 6, valid: 1, invalid: 5 });
    expect(data.errors.map((e: any) => `${e.row}:${e.field}:${e.code}`)).toEqual([
      "3:companyName:WRONG_LENGTH",
      "4:phone:WRONG_LENGTH",
      "5:notes:WRONG_LENGTH",
      "6:companyName:SINGLE_LINE_ONLY",
      "7:displayName:WRONG_LENGTH",
    ]);
  });

  it("stores the counts and only row numbers, fields and codes on the job (no cell contents)", async () => {
    const { data } = await body(await send(text));
    const stored = psql(
      `select total_rows || '|' || rejected_rows || '|' || error_summary::text from public.import_jobs where id = '${data.importJobId}'`,
    );
    expect(stored).toMatch(/^5\|3\|/);
    expect(stored).toContain('"code": "INVALID_EMAIL"');
    expect(stored).not.toMatch(/not-an-email|nobody@errors|Cy Young|Di Prince/);
  });
});

describe("duplicates", () => {
  it("warns about e-mails repeated in the file and ones the workspace already has, and still counts the rows valid", async () => {
    const made = await server.request("/api/v1/customers", owner, {
      json: { displayName: "Existing Person", email: "existing@dup.test" },
      headers: { "X-Organization-Id": orgA },
    });
    expect(made.status).toBe(201);
    const { data } = await body(
      await send(
        "display_name,email\nOne,same@dup.test\nTwo,SAME@dup.test\nThree,existing@dup.test\n",
      ),
    );
    expect(data.counts).toEqual({ total: 3, valid: 3, invalid: 0 });
    expect(data.warnings.map((w: any) => `${w.row}:${w.code}`)).toEqual([
      "3:DUPLICATE_IN_FILE",
      "4:DUPLICATE_EXISTING",
    ]);
    expect(data.warnings[0].firstRow).toBe(2);
  });
});

describe("repeat protection", () => {
  it("re-uploading the same file returns the same job (200) and creates no second one", async () => {
    const text = csv(3).replace("Customer 0", "Repeat Customer");
    const first = await send(text);
    expect(first.status).toBe(201);
    const a = (await body(first)).data;
    const before = jobs(orgA);
    const again = await send(text);
    expect(again.status).toBe(200);
    const b = (await body(again)).data;
    expect(b.importJobId).toBe(a.importJobId);
    expect(b.fileSha256).toBe(a.fileSha256);
    expect(jobs(orgA)).toBe(before);
  });

  it("two identical uploads at the same moment still make one job", async () => {
    const text = csv(2).replace("Customer 0", "Concurrent Customer");
    const before = jobs(orgA);
    const results = await Promise.all([send(text), send(text), send(text)]);
    const ids = new Set<string>();
    for (const r of results) ids.add((await body(r)).data.importJobId);
    expect(ids.size).toBe(1);
    expect(jobs(orgA)).toBe(before + 1);
  });

  it("a different file is a different job, and another workspace never shares a job", async () => {
    const text = csv(2).replace("Customer 0", "Shared Bytes Customer");
    const a = (await body(await send(text))).data;
    const changed = (await body(await send(text + "\n\n"))).data; // different bytes
    expect(changed.importJobId).not.toBe(a.importJobId);
    const inB = await send(text, other, orgB);
    expect(inB.status).toBe(201);
    expect((await body(inB)).data.importJobId).not.toBe(a.importJobId);
  });

  it("an expired preview is replaced by a new job", async () => {
    const text = csv(2).replace("Customer 0", "Expiring Customer");
    const a = (await body(await send(text))).data;
    psql(`alter table public.import_jobs disable trigger import_jobs_protect_columns`);
    psql(
      `update public.import_jobs set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = '${a.importJobId}'`,
    );
    psql(`alter table public.import_jobs enable trigger import_jobs_protect_columns`);
    const again = await send(text);
    expect(again.status).toBe(201);
    expect((await body(again)).data.importJobId).not.toBe(a.importJobId);
  });
});

describe("limits", () => {
  it("accepts a file of exactly 2 MB and rejects one byte more with 413", async () => {
    const limit = 2 * 1024 * 1024;
    const head = "display_name,notes\n";
    const rows: string[] = [];
    let size = head.length;
    for (let i = 0; i < 1000; i++) {
      const prefix = `C${i},`;
      rows.push(prefix);
      size += prefix.length + 1; // the cell is filled below; +1 for the newline
    }
    let remaining = limit - size;
    const filled = rows.map((prefix) => {
      const take = Math.min(remaining, 2200);
      remaining -= take;
      return prefix + "x".repeat(take);
    });
    const exact = head + filled.join("\n") + "\n";
    expect(Buffer.byteLength(exact)).toBe(limit);
    const ok = await send(exact);
    expect(ok.status).toBe(201);
    expect((await body(ok)).data.counts.total).toBe(1000);
    const over = await send(exact + "\n");
    expect(over.status).toBe(413);
    const err = (await body(over)).error;
    expect(err.code).toBe("PAYLOAD_TOO_LARGE");
    expect(err.message).toMatch(/2 MB/);
  });

  it("accepts 1,000 rows and rejects 1,001 with 422", async () => {
    expect((await send(csv(1000).replace("Customer 0", "Thousand"))).status).toBe(201);
    const res = await send(csv(1001));
    expect(res.status).toBe(422);
    const err = (await body(res)).error;
    expect(err.code).toBe("IMPORT_TOO_MANY_ROWS");
    expect(err.message).toMatch(/1000/);
  });

  it("an enormous body is cut off by the size cap before it is read", async () => {
    const res = await call(owner, { content: "A".repeat(5_000_000) });
    expect(res.status).toBe(413);
  });
});

describe("files that cannot be previewed", () => {
  const code = async (res: Response) => (await body(res)).error.code;
  it("422: not UTF-8", async () => {
    const res = await send(Buffer.from([0x64, 0x69, 0x73, 0xff, 0xfe, 0x0a, 0x41]));
    expect(res.status).toBe(422);
    expect(await code(res)).toBe("IMPORT_NOT_UTF8");
  });
  it("422: empty file, missing name column, no rows, unterminated quote", async () => {
    const empty = await call(owner, { content: Buffer.alloc(0).toString("base64") });
    expect(empty.status).toBe(422); // an empty `content` is refused by the schema
    expect(await code(await send("\n\n"))).toBe("IMPORT_EMPTY_FILE");
    expect(await code(await send("email\na@x.test\n"))).toBe("IMPORT_MISSING_COLUMN");
    expect(await code(await send("display_name\n"))).toBe("IMPORT_NO_DATA_ROWS");
    expect(await code(await send('display_name\n"never closed\n'))).toBe("IMPORT_NOT_CSV");
  });
  it("422: text that is not base64, or extra fields in the body", async () => {
    expect((await call(owner, { content: "not base64!!" })).status).toBe(422);
    expect((await call(owner, { content: "QQ==", organizationId: orgB })).status).toBe(422);
    expect((await call(owner, {})).status).toBe(422);
  });
  it("writes no job for any of them", async () => {
    const before = jobs(orgA);
    await send("email\na@x.test\n");
    await send(Buffer.from([0xff, 0xfe]));
    expect(jobs(orgA)).toBe(before);
  });
});

describe("who may preview", () => {
  const text = "display_name\nRole Check\n";
  it("owner and member can; a viewer gets 403; nobody is signed out", async () => {
    expect((await send(text, owner)).status).toBeLessThan(300);
    expect((await send(text, member)).status).toBeLessThan(300);
    const v = await send(text, viewer);
    expect(v.status).toBe(403);
    expect((await body(v)).error.code).toBe("FORBIDDEN");
    expect((await send(text, null)).status).toBe(401);
  });
  it("a non-member gets 404, and another workspace's id gets 404", async () => {
    expect((await send(text, outsider)).status).toBe(404);
    expect((await send(text, owner, orgB)).status).toBe(404);
  });
  it("a viewer's 403 comes before the body is read", async () => {
    expect((await call(viewer, { nonsense: true })).status).toBe(403);
  });
  it("a demo guest can preview in their own demo and is told the customer capacity", async () => {
    const res = await send("display_name\nGuest Import One\nGuest Import Two\n", guest, demoOrg);
    expect(res.status).toBe(201);
    const { data } = await body(res);
    expect(data.demo.wouldExceed).toBe(false);
    expect(data.demo.remaining).toBe(50 - customers(demoOrg));
  });
  it("warns when the import would go over the demo customer cap", async () => {
    const remaining = 50 - customers(demoOrg);
    const res = await send(csv(remaining + 1).replace("Customer 0", "Cap Probe"), guest, demoOrg);
    expect(res.status).toBe(201);
    const { data } = await body(res);
    expect(data.demo).toEqual({ remaining, wouldExceed: true });
  });
  it("a guest cannot preview into a real workspace", async () => {
    expect((await send(text, guest, orgA)).status).toBe(404);
  });
});
