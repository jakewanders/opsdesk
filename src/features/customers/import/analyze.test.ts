import { describe, expect, it } from "vitest";
import {
  analyzeCustomerCsv,
  ImportFileError,
  MAX_STORED_ERRORS,
  PREVIEW_ROWS,
  storedErrorSummary,
} from "./analyze";

const none = new Set<string>();
const fileError = (text: string) => {
  try {
    analyzeCustomerCsv(text, none);
  } catch (e) {
    if (e instanceof ImportFileError) return e;
    throw e;
  }
  throw new Error("expected an ImportFileError");
};

describe("analyzeCustomerCsv: columns", () => {
  it("maps the documented names and common aliases, ignoring case, spaces and punctuation", () => {
    const a = analyzeCustomerCsv(
      "Display Name,Company,E-mail Address,Phone Number,URL\nAda,Acme,ada@x.co,555,https://x.co\n",
      none,
    );
    expect(a.columns.mapped.map((m) => m.field)).toEqual([
      "displayName",
      "companyName",
      "email",
      "phone",
      "website",
    ]);
    expect(a.validRows).toBe(1);
    expect(a.valid[0].input).toMatchObject({
      displayName: "Ada",
      companyName: "Acme",
      email: "ada@x.co",
      website: "https://x.co",
    });
  });
  it("reports unknown columns instead of dropping them silently", () => {
    const a = analyzeCustomerCsv("display_name,favorite_color,Region\nAda,blue,East\n", none);
    expect(a.columns.unknown).toEqual(["favorite_color", "Region"]);
    expect(a.validRows).toBe(1);
  });
  it("refuses a file without a name column", () => {
    const e = fileError("email,phone\na@x.co,1\n");
    expect(e.code).toBe("MISSING_COLUMN");
    expect(e.message).toMatch(/display_name/);
  });
  it("refuses two columns that fill the same field", () => {
    expect(fileError("name,display_name\nA,B\n").code).toBe("DUPLICATE_COLUMN");
  });
  it("refuses a file with no data rows", () => {
    expect(fileError("display_name\n").code).toBe("NO_DATA_ROWS");
    expect(fileError("").code).toBe("EMPTY_FILE");
  });
  it("refuses a quote that never closes", () => {
    expect(fileError('display_name\n"Ada\n').code).toBe("NOT_CSV");
  });
});

describe("analyzeCustomerCsv: row validation", () => {
  const csv = [
    "display_name,email,type,status,source,tags,website",
    "Ada Lovelace,ada@x.co,person,lead,referral,vip;london,https://x.co", // 2 valid
    ",nobody@x.co,person,lead,other,,", // 3 no name
    "B,not-an-email,person,lead,other,,", // 4 name too short + bad email
    "Cy Young,cy@x.co,robot,lead,other,,", // 5 bad type
    "Di Prince,di@x.co,COMPANY,Active,WEBSITE,,", // 6 valid (enum case ignored)
    "Ed Wynn,ed@x.co,person,lead,other,,javascript:alert(1)", // 7 bad website
    "<b>Fay</b> Wray,fay@x.co,person,lead,other,,", // 8 html
  ].join("\n");
  const a = analyzeCustomerCsv(csv, none);

  it("counts valid and invalid rows", () => {
    expect([a.totalRows, a.validRows, a.invalidRows]).toEqual([7, 2, 5]);
  });
  it("reports the exact row, field and code of every problem", () => {
    const pairs = a.errors.map((e) => `${e.row}:${e.field}:${e.code}`);
    expect(pairs).toEqual([
      "3:displayName:REQUIRED",
      "4:displayName:WRONG_LENGTH",
      "4:email:INVALID_EMAIL",
      "5:type:INVALID_CHOICE",
      "7:website:INVALID_VALUE",
      "8:displayName:NO_HTML",
    ]);
  });
  it("gives every problem a plain-language message", () => {
    for (const e of a.errors) expect(e.message.length).toBeGreaterThan(5);
    expect(a.errors.find((e) => e.row === 3)?.message).toBe("Enter a name.");
  });
  it("accepts enum values in any case and splits tags on ; , |", () => {
    expect(a.valid.map((v) => v.input.type)).toEqual(["person", "company"]);
    expect(a.valid[1].input.status).toBe("active");
    expect(a.valid[0].input.tags).toEqual(["vip", "london"]);
    const t = analyzeCustomerCsv('display_name,tags\nAda,"a, b|c ;a"\n', none);
    expect(t.valid[0].input.tags).toEqual(["a", "b", "c"]);
  });
  it("numbers rows like a spreadsheet: the header is row 1", () => {
    expect(a.rows.map((r) => r.row)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
  it("flags a row with more cells than the header", () => {
    const b = analyzeCustomerCsv("display_name\nAda,extra\n", none);
    expect(b.errors).toMatchObject([{ row: 2, field: null, code: "TOO_MANY_CELLS" }]);
    const c = analyzeCustomerCsv("display_name,email\nAda,a@x.co,\n", none);
    expect(c.invalidRows).toBe(0);
  });
  it("treats short rows as blank for the missing cells", () => {
    const b = analyzeCustomerCsv("display_name,email,phone\nAda\n", none);
    expect(b.validRows).toBe(1);
  });
  it("stores formula-looking text as plain text", () => {
    const b = analyzeCustomerCsv('display_name,notes,company\n=Ada,"=1+1",@Acme\n', none);
    expect(b.valid[0].input).toMatchObject({
      displayName: "=Ada",
      notes: "=1+1",
      companyName: "@Acme",
    });
  });
  it("uses the create-customer defaults for blank optional cells", () => {
    const b = analyzeCustomerCsv("display_name,type,status,source\nAda,,,\n", none);
    expect(b.valid[0].input).toMatchObject({
      type: "person",
      status: "lead",
      source: "other",
      email: null,
      tags: [],
    });
  });
});

describe("analyzeCustomerCsv: duplicates", () => {
  it("warns about an e-mail used twice in the file, pointing at the first row", () => {
    const a = analyzeCustomerCsv(
      "display_name,email\nAda,A@X.co\nBob,b@x.co\nAda Two,a@x.CO\n",
      none,
    );
    expect(a.warnings).toEqual([
      {
        row: 4,
        field: "email",
        code: "DUPLICATE_IN_FILE",
        message: "This email address is also on row 2.",
        firstRow: 2,
      },
    ]);
    expect(a.validRows).toBe(3); // a warning never rejects a row
  });
  it("warns about an e-mail the workspace already has", () => {
    const a = analyzeCustomerCsv(
      "display_name,email\nAda,ada@x.co\nBob,bob@x.co\n",
      new Set(["ada@x.co"]),
    );
    expect(a.warnings.map((w) => `${w.row}:${w.code}`)).toEqual(["2:DUPLICATE_EXISTING"]);
  });
  it("does not warn about blank e-mails", () => {
    const a = analyzeCustomerCsv("display_name,email\nAda,\nBob,\n", none);
    expect(a.warnings).toEqual([]);
  });
});

describe("analyzeCustomerCsv: size", () => {
  const body = (n: number) =>
    "display_name\n" + Array.from({ length: n }, (_, i) => `Customer ${i}`).join("\n");
  it("accepts 1,000 rows", () => {
    const a = analyzeCustomerCsv(body(1000), none);
    expect([a.totalRows, a.validRows]).toEqual([1000, 1000]);
  });
  it("rejects 1,001 rows", () => {
    const e = fileError(body(1001));
    expect(e.code).toBe("TOO_MANY_ROWS");
    expect(e.message).toMatch(/1000/);
  });
  it("shows only the first 20 rows but counts them all", () => {
    const a = analyzeCustomerCsv(body(50), none);
    expect(a.rows).toHaveLength(PREVIEW_ROWS);
    expect(a.totalRows).toBe(50);
  });
});

describe("storedErrorSummary", () => {
  it("keeps row numbers, fields and codes only, and counts by code", () => {
    const a = analyzeCustomerCsv("display_name,email\nA,secret@private.example\n,ok@x.co\n", none);
    const s = storedErrorSummary(a);
    expect(s.errors).toEqual([
      { row: 2, field: "displayName", code: "WRONG_LENGTH" },
      { row: 3, field: "displayName", code: "REQUIRED" },
    ]);
    expect(s.byCode).toEqual({ WRONG_LENGTH: 1, REQUIRED: 1 });
    expect(JSON.stringify(s)).not.toMatch(/secret|private\.example|ok@x\.co/);
  });
  it("is capped, and stays far below the table's 20,000 byte limit", () => {
    const rows = Array.from({ length: 1000 }, () => "").join("\n,x@x.co");
    const a = analyzeCustomerCsv(
      "display_name,email\n" + Array.from({ length: 1000 }, () => ",x@x.co").join("\n"),
      none,
    );
    void rows;
    const s = storedErrorSummary(a);
    expect(s.errors).toHaveLength(MAX_STORED_ERRORS);
    expect(s.truncated).toBe(true);
    expect(JSON.stringify(s).length).toBeLessThan(20000);
  });
});
