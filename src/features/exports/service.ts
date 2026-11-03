import type { SupabaseClient } from "@supabase/supabase-js";
import { countCustomers, exportCustomerChunks } from "@/features/customers/repository";
import { customerListQuery } from "@/features/customers/schema";
import {
  countOpportunitiesForExport,
  exportOpportunityChunks,
} from "@/features/opportunities/repository";
import { opportunityListQuery } from "@/features/opportunities/schema";
import { reportQuery } from "@/features/reports/schema";
import { getReport } from "@/features/reports/service";
import { countTasksForExport, exportTaskChunks } from "@/features/tasks/repository";
import { taskListQuery } from "@/features/tasks/schema";
import { NotFoundError, ValidationError } from "@/lib/api/errors";
import type { OrgContext } from "@/lib/api/org-context";
import { CSV_BOM, csvRow, type CsvValue } from "@/lib/csv/write";
import { todayInZone } from "@/lib/domain/tasks";
import { assertCan } from "@/lib/permissions";
import type { Database } from "@/lib/supabase/database.types";
import { parseQuery } from "@/lib/validation";
import {
  CUSTOMER_EXPORT_COLUMNS,
  DEMO_MARKER,
  OPPORTUNITY_EXPORT_COLUMNS,
  REPORT_EXPORT_HEADERS,
  TASK_EXPORT_COLUMNS,
} from "./columns";

type Client = SupabaseClient<Database>;

/** The only entities that can be exported. Anything else is a 404. */
export const EXPORT_ENTITIES = ["customers", "opportunities", "tasks", "reports"] as const;
export type ExportEntity = (typeof EXPORT_ENTITIES)[number];
/** The most rows one list export may contain; a bigger result is refused (422), never cut short without saying so. */
export const EXPORT_ROW_LIMIT = 10_000;

export type ExportFile = {
  filename: string;
  /** The CSV, produced a chunk at a time. */
  body: ReadableStream<Uint8Array>;
  /** How many data rows it will contain. */
  rows: number;
};

const isEntity = (value: string): value is ExportEntity =>
  (EXPORT_ENTITIES as readonly string[]).includes(value);

/**
 * Builds a CSV export of the workspace's customers, opportunities, tasks, or report data. The query string is the LIST endpoint's own
 * (validated by the same schema, so every filter and `sort`/`order` works the same); `page` and `limit` are ignored because an export is
 * the whole filtered set. `bom=true` puts a UTF-8 byte-order mark first so Excel opens the file as UTF-8. Read as the caller (row level
 * security applies), so another workspace's rows can never be in the file. Everyone who can read the workspace can export it.
 */
export async function buildExport(
  supabase: Client,
  ctx: OrgContext,
  entity: string,
  searchParams: URLSearchParams,
  now: Date = new Date(),
): Promise<ExportFile> {
  assertCan(ctx.role, ctx.kind, "records.read");
  if (!isEntity(entity)) throw new NotFoundError("That export does not exist.", "EXPORT_NOT_FOUND");

  const params = new URLSearchParams(searchParams);
  const bomValue = params.get("bom");
  if (bomValue !== null && bomValue !== "true" && bomValue !== "false")
    throw new ValidationError("Some filters are not valid.", { bom: ["Use true or false."] });
  const bom = bomValue === "true";
  params.delete("bom");
  if (entity !== "reports") {
    params.delete("page");
    params.delete("limit");
  }

  const today = todayInZone(now, ctx.org.timezone);
  const filename = `${entity}-${today}.csv`;
  const exportedAt = now.toISOString();
  const demo = ctx.org.kind === "demo";
  const trailer = (): CsvValue[] => (demo ? [exportedAt, DEMO_MARKER] : [exportedAt]);
  const trailerHeaders = demo ? ["exported_at", DEMO_MARKER] : ["exported_at"];

  type Source = {
    headers: string[];
    rows: number;
    chunks: () => AsyncGenerator<CsvValue[][]>;
  };
  let source: Source;

  if (entity === "customers") {
    const query = parseQuery(customerListQuery, params);
    const total = await countCustomers(supabase, ctx.org.id, query, ctx.org.timezone);
    assertWithinLimit(total);
    source = {
      headers: CUSTOMER_EXPORT_COLUMNS.map(([h]) => h),
      rows: total,
      chunks: async function* () {
        for await (const chunk of exportCustomerChunks(
          supabase,
          ctx.org.id,
          query,
          ctx.org.timezone,
        ))
          yield chunk.map((r) => [...CUSTOMER_EXPORT_COLUMNS.map(([, f]) => f(r)), ...trailer()]);
      },
    };
  } else if (entity === "opportunities") {
    const query = parseQuery(opportunityListQuery, params);
    const total = await countOpportunitiesForExport(supabase, ctx.org.id, query);
    assertWithinLimit(total);
    source = {
      headers: OPPORTUNITY_EXPORT_COLUMNS.map(([h]) => h),
      rows: total,
      chunks: async function* () {
        for await (const chunk of exportOpportunityChunks(supabase, ctx.org.id, query))
          yield chunk.map((r) => [
            ...OPPORTUNITY_EXPORT_COLUMNS.map(([, f]) => f(r)),
            ...trailer(),
          ]);
      },
    };
  } else if (entity === "tasks") {
    const query = parseQuery(taskListQuery, params);
    const scope = { orgId: ctx.org.id, userId: ctx.user.id, today };
    const total = await countTasksForExport(supabase, scope, query);
    assertWithinLimit(total);
    source = {
      headers: TASK_EXPORT_COLUMNS.map(([h]) => h),
      rows: total,
      chunks: async function* () {
        for await (const chunk of exportTaskChunks(supabase, scope, ctx.org.timezone, query))
          yield chunk.map((r) => [...TASK_EXPORT_COLUMNS.map(([, f]) => f(r)), ...trailer()]);
      },
    };
  } else {
    const query = parseQuery(reportQuery, params);
    const report = await getReport(supabase, ctx, query, now);
    const rows: CsvValue[][] = [];
    const { from, to } = report.range;
    for (const b of report.buckets)
      for (const metric of [
        "opportunitiesCreated",
        "opportunitiesWon",
        "opportunitiesLost",
        "wonAmountCents",
        "tasksCompleted",
      ] as const)
        rows.push(["series", "", b.start, b.end, metric, b[metric], ...trailer()]);
    for (const [source, count] of Object.entries(report.customersBySource))
      rows.push(["customers_by_source", source, from, to, "customers", count, ...trailer()]);
    for (const [stage, v] of Object.entries(report.opportunitiesByStage)) {
      rows.push(["deals_by_stage_now", stage, "", "", "count", v.count, ...trailer()]);
      rows.push(["deals_by_stage_now", stage, "", "", "amount_cents", v.amountCents, ...trailer()]);
    }
    source = {
      headers: [...REPORT_EXPORT_HEADERS],
      rows: rows.length,
      chunks: async function* () {
        yield rows;
      },
    };
  }

  const encoder = new TextEncoder();
  const chunks = source.chunks();
  let started = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!started) {
          started = true;
          controller.enqueue(
            encoder.encode((bom ? CSV_BOM : "") + csvRow([...source.headers, ...trailerHeaders])),
          );
          return;
        }
        const next = await chunks.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value.map((r) => csvRow(r)).join("")));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  return { filename, body, rows: source.rows };
}

function assertWithinLimit(total: number) {
  if (total > EXPORT_ROW_LIMIT)
    throw new ValidationError(
      `This export has ${total.toLocaleString("en-US")} rows; the limit is ${EXPORT_ROW_LIMIT.toLocaleString("en-US")}. Add filters to narrow it and try again.`,
      undefined,
      "EXPORT_TOO_LARGE",
    );
}
